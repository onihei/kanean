import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kanean/capture/capture_service.dart';
import 'package:kanean/capture/quality.dart';
import 'package:kanean/contract/receipt_contract.dart';
import 'package:kanean/data/database.dart';
import 'package:kanean/data/providers.dart';
import 'package:kanean/main.dart';
import 'package:kanean/ui/confirm_screen.dart';

/// 画面まわりで守りたいこと（receipt-capture spec）。
/// **支払手段を選ばないと送れない**ことと、**「送信済み」を「登録済み」と書かない**こと。
void main() {
  late KaneanDatabase db;

  setUp(() => db = KaneanDatabase(NativeDatabase.memory()));
  tearDown(() => db.close());

  Future<void> pumpApp(WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [databaseProvider.overrideWithValue(db)],
        child: const KaneanApp(),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> insert(String id, {String state = 'pending'}) => db.into(db.captures).insert(
        CapturesCompanion.insert(
          id: id,
          capturedAt: '2026-08-14T12:00:00+09:00',
          imagePath: '/tmp/$id.jpg',
          imageFileName: '$id.jpg',
          imageContentType: 'image/jpeg',
          imageSizeBytes: 1000,
          imageSha256: 'a' * 64,
          paymentMethod: 'cash',
          deliveryState: Value(state),
          ocrDate: const Value('2026-08-14'),
          ocrTotalAmount: const Value(1200),
        ),
      );

  group('履歴', () {
    testWidgets('撮っていなければ、何が起きるかを添えて空を出す', (tester) async {
      await pumpApp(tester);
      expect(find.text('まだ撮っていません'), findsOneWidget);
      // 画像が外部の AI へ渡ることを隠さない（receipt-inbox spec「外部へ渡る情報の明示」）。
      expect(find.textContaining('AI が読み取って'), findsOneWidget);
      expect(find.textContaining('店名・金額・撮影場所'), findsOneWidget);
    });

    testWidgets('読めなかった日付を撮影日で埋めない', (tester) async {
      // 埋めると「レシートから読んだ日付」に見える（実際に誤解を招いた）。
      await db.into(db.captures).insert(
            CapturesCompanion.insert(
              id: '01B',
              capturedAt: '2026-08-23T01:34:42.942211Z',
              imagePath: '/tmp/01B.png',
              imageFileName: '01B.png',
              imageContentType: 'image/png',
              imageSizeBytes: 1000,
              imageSha256: 'b' * 64,
              paymentMethod: 'cash',
              ocrTotalAmount: const Value(5346),
            ),
          );
      await pumpApp(tester);
      expect(find.textContaining('日付は読み取れず'), findsOneWidget);
      // 撮影日が下読みの日付として出てはいけない。
      expect(find.textContaining('2026-08-23  5346円（下読み）'), findsNothing);
    });

    testWidgets('日付も金額も読めなければそう書く', (tester) async {
      await db.into(db.captures).insert(
            CapturesCompanion.insert(
              id: '01C',
              capturedAt: '2026-08-23T01:34:42.942211Z',
              imagePath: '/tmp/01C.png',
              imageFileName: '01C.png',
              imageContentType: 'image/png',
              imageSizeBytes: 1000,
              imageSha256: 'c' * 64,
              paymentMethod: 'cash',
            ),
          );
      await pumpApp(tester);
      expect(find.textContaining('読み取れず'), findsOneWidget);
    });

    testWidgets('未送信を未送信と書く', (tester) async {
      await insert('01A');
      await pumpApp(tester);
      expect(find.text('未送信'), findsOneWidget);
    });

    testWidgets('「送信済み」と「登録済み」を混同させない', (tester) async {
      await insert('01A', state: 'sent');
      await pumpApp(tester);
      expect(find.text('送信済み（未登録）'), findsOneWidget);
      expect(find.text('登録済み'), findsNothing);
    });

    testWidgets('登録できたら要約を出す', (tester) async {
      await insert('01A', state: 'sent');
      await db.into(db.receiptStatuses).insert(
            ReceiptStatusesCompanion.insert(
              id: '01A',
              processedAt: '2026-08-14T21:00:00+09:00',
              registered: true,
              summaryEntryId: const Value(4821),
              summaryDate: const Value('2026-08-14'),
              summaryTotalAmount: const Value(1200),
              summaryAccountName: const Value('消耗品費'),
            ),
          );
      await pumpApp(tester);
      expect(find.text('登録済み'), findsOneWidget);
      expect(find.textContaining('消耗品費'), findsOneWidget);
    });

    testWidgets('登録されなかった理由を出す', (tester) async {
      await insert('01A', state: 'sent');
      await db.into(db.receiptStatuses).insert(
            ReceiptStatusesCompanion.insert(
              id: '01A',
              processedAt: '2026-08-14T21:00:00+09:00',
              registered: false,
              reason: const Value('unmatched_card'),
              detail: const Value('一致するカード明細が無い'),
            ),
          );
      await pumpApp(tester);
      expect(find.textContaining('要対応'), findsOneWidget);
      expect(find.textContaining('一致するカード明細が無い'), findsOneWidget);
    });
  });

  group('確認画面', () {
    CaptureDraft draft({List<QualityFlag> flags = const [], ReceiptOcr ocr = const ReceiptOcr()}) =>
        CaptureDraft(
          imagePath: '/tmp/a.jpg',
          quality: QualityReport(
            flags: flags,
            blurVariance: 900,
            glareRatio: 0,
            edgeInkRatio: 0,
          ),
          ocr: ocr,
        );

    Future<void> pumpConfirm(WidgetTester tester, CaptureDraft d) async {
      // 指摘が出ると背が伸びる。画面を高くして、スクロール位置に結果が左右されないようにする。
      tester.view.physicalSize = const Size(1200, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [databaseProvider.overrideWithValue(db)],
          child: MaterialApp(home: ConfirmScreen(draft: d, onRetake: () {})),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('支払手段を選ぶまで送れない', (tester) async {
      await pumpConfirm(tester, draft());
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);

      await tester.tap(find.text('現金'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
    });

    testWidgets('選択操作でキーボードを引っ込める', (tester) async {
      // numberPad には完了キーが無い。閉じる手段が無いと人数を打った後に詰む。
      await pumpConfirm(tester, draft());
      await tester.tap(find.widgetWithText(TextField, '何人で'));
      await tester.pumpAndSettle();
      expect(FocusManager.instance.primaryFocus?.hasFocus, isTrue);

      await tester.tap(find.text('現金'));
      await tester.pumpAndSettle();
      expect(
        FocusManager.instance.primaryFocus?.context?.widget,
        isNot(isA<EditableText>()),
        reason: '支払手段を選んだらキーボードは閉じる',
      );
    });

    testWidgets('スクロールでもキーボードを引っ込める', (tester) async {
      await pumpConfirm(tester, draft());
      final list = tester.widget<ListView>(find.byType(ListView));
      expect(list.keyboardDismissBehavior, ScrollViewKeyboardDismissBehavior.onDrag);
    });

    testWidgets('カードを選ぶと突合になることを伝える', (tester) async {
      await pumpConfirm(tester, draft());
      await tester.tap(find.text('カード'));
      await tester.pumpAndSettle();
      expect(find.textContaining('証憑として突き合わせ'), findsOneWidget);
    });

    testWidgets('検査の指摘は塞がず、撮り直しの道を出す', (tester) async {
      await pumpConfirm(tester, draft(flags: [QualityFlag.blur]));
      expect(find.textContaining('ぶれ'), findsOneWidget);
      expect(find.text('撮り直す'), findsOneWidget);
      // 指摘があっても、支払手段さえ選べば押し切れる。
      await tester.tap(find.text('現金'));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
    });

    testWidgets('指摘が無いときは撮り直すを出さない', (tester) async {
      // 「この内容で送る」の真下に置くと誤タップの的になる。戻るだけなら左上で足りる。
      await pumpConfirm(tester, draft());
      expect(find.text('撮り直す'), findsNothing);
    });

    testWidgets('読み取れなければ、そのまま送れると伝える', (tester) async {
      await pumpConfirm(tester, draft());
      expect(find.textContaining('読み取れませんでした'), findsOneWidget);
    });

    testWidgets('読めた日付と金額は確認用と断って出す', (tester) async {
      await pumpConfirm(tester, draft(ocr: const ReceiptOcr(date: '2026-08-14', totalAmount: 1200)));
      expect(find.textContaining('2026-08-14'), findsOneWidget);
      expect(find.textContaining('1200円'), findsOneWidget);
      expect(find.textContaining('確認用の下読み'), findsOneWidget);
    });
  });
}
