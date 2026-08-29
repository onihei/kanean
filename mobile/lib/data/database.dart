import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

import '../contract/receipt_contract.dart';

part 'database.g.dart';

/// 端末内の保存（receipt-capture spec「端末は会計データを持たない」）。
///
/// 持ってよいのは**自分が撮ったものとその送信状態**だけ。仕訳・残高・勘定科目マスタは
/// 一切置かないし、取りに行く経路も持たない。
///
/// テーブルは2つ。**こちらが書いたもの（[Captures]）**と、**Mac から返ってきたもの
/// （[ReceiptStatuses]）**。分けておくと「送信済みだが status がまだ」＝登録済みと
/// 区別すべき状態が、行の有無としてそのまま表せる。

/// 撮ったもの1件と、その送信状態。
class Captures extends Table {
  /// ULID。画像・メタ・status の三者を結ぶ鍵（inbox 上のファイル名にもなる）。
  TextColumn get id => text()();
  TextColumn get capturedAt => text()();

  /// 端末内の画像の実体。送信できるまでここに置く。
  TextColumn get imagePath => text()();
  TextColumn get imageFileName => text()();
  TextColumn get imageContentType => text()();
  IntColumn get imageSizeBytes => integer()();

  /// 冪等の鍵。撮影時に計算してメタに載せる。
  TextColumn get imageSha256 => text()();

  /// 現金／カード。**未選択のまま送信させない**ので nullable にしない。
  TextColumn get paymentMethod => text()();
  TextColumn get usage => text().nullable()();
  IntColumn get mealPartySize => integer().nullable()();

  /// 飲食の相手（JSON 配列）。人数だけ分かって相手が空でもよい。
  TextColumn get mealParticipants => text().nullable()();
  TextColumn get memo => text().nullable()();

  /// 端末 OCR の下読み。読めなくても撮影は成立するので nullable。
  TextColumn get ocrDate => text().nullable()();
  IntColumn get ocrTotalAmount => integer().nullable()();

  /// 簡易検査の指摘（JSON 配列）。押し切られた場合も理由として残す。
  TextColumn get qualityFlags => text().nullable()();

  /// 'pending'（未送信）/ 'sent'（送信済み）/ 'failed'（要対応）。
  TextColumn get deliveryState => text().withDefault(const Constant('pending'))();
  IntColumn get attempts => integer().withDefault(const Constant(0))();

  /// 失敗の理由。**繰り返し失敗しても件を消さない**ので、理由を持って残る。
  TextColumn get lastError => text().nullable()();
  TextColumn get lastTriedAt => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Mac 側が書き戻した結果。行が無い＝まだ返っていない（＝登録済みではない）。
class ReceiptStatuses extends Table {
  TextColumn get id => text()();
  TextColumn get processedAt => text()();
  BoolColumn get registered => boolean()();

  /// 未登録の理由。registered=false のとき必ず入る。
  TextColumn get reason => text().nullable()();
  TextColumn get detail => text().nullable()();

  IntColumn get summaryEntryId => integer().nullable()();
  TextColumn get summaryDate => text().nullable()();
  IntColumn get summaryTotalAmount => integer().nullable()();
  TextColumn get summaryAccountName => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// 履歴に出す状態（receipt-capture spec「送信状態を明示する」）。
enum CaptureState {
  /// まだ送れていない（圏外で撮った等）。
  pending,

  /// 送ったが status がまだ返っていない。**登録済みと混同させない。**
  sent,

  /// Mac 側で draft 仕訳＋証憑になった。
  registered,

  /// 送信に失敗し続けている、または Mac 側が登録しなかった（重複以外）。
  needsAttention,
}

@DriftDatabase(tables: [Captures, ReceiptStatuses])
class KaneanDatabase extends _$KaneanDatabase {
  KaneanDatabase([QueryExecutor? executor])
      : super(executor ?? driftDatabase(name: 'kanean'));

  @override
  int get schemaVersion => 1;

  /// 送信待ちの列（撮った順）。オフラインで溜まったぶんもここに並ぶ。
  Future<List<Capture>> pendingQueue() =>
      (select(captures)
            ..where((t) => t.deliveryState.equals('pending'))
            ..orderBy([(t) => OrderingTerm.asc(t.capturedAt)]))
          .get();

  /// 読み取り履歴（新しい順）と、各件の状態。
  Future<List<({Capture capture, ReceiptStatus? status, CaptureState state})>> history() async {
    final rows = await (select(captures)
          ..orderBy([(t) => OrderingTerm.desc(t.capturedAt)]))
        .join([
      leftOuterJoin(receiptStatuses, receiptStatuses.id.equalsExp(captures.id)),
    ]).get();

    return rows.map((row) {
      final capture = row.readTable(captures);
      final statusRow = row.readTableOrNull(receiptStatuses);
      final status = statusRow == null ? null : _toContract(statusRow);
      return (capture: capture, status: status, state: stateOf(capture, status));
    }).toList();
  }

  static ReceiptStatus _toContract(ReceiptStatuse row) => ReceiptStatus(
        id: row.id,
        processedAt: row.processedAt,
        registered: row.registered,
        reason: row.reason == null ? null : ReceiptSkipReason.fromWire(row.reason!),
        detail: row.detail,
        summary: row.registered
            ? ReceiptSummary(
                entryId: row.summaryEntryId!,
                date: row.summaryDate!,
                totalAmount: row.summaryTotalAmount!,
                accountName: row.summaryAccountName!,
              )
            : null,
      );

  /// 1件の状態を決める。**status が返っていないものを「登録済み」にしない。**
  static CaptureState stateOf(Capture capture, ReceiptStatus? status) {
    if (status != null) {
      if (status.registered) return CaptureState.registered;
      // 重複＝既に本体側に証憑がある。利用者が対応することは無いので登録済み扱いでよい。
      if (status.reason == ReceiptSkipReason.duplicate) return CaptureState.registered;
      return CaptureState.needsAttention;
    }
    return switch (capture.deliveryState) {
      'failed' => CaptureState.needsAttention,
      'sent' => CaptureState.sent,
      _ => CaptureState.pending,
    };
  }

  /// 端末の行から、inbox へ書くメタを組み立てる（契約は [ReceiptMeta] が正）。
  static ReceiptMeta metaOf(Capture c) => ReceiptMeta(
        id: c.id,
        capturedAt: c.capturedAt,
        image: ReceiptImage(
          fileName: c.imageFileName,
          contentType: c.imageContentType,
          sizeBytes: c.imageSizeBytes,
          sha256: c.imageSha256,
        ),
        paymentMethod: PaymentMethod.fromWire(c.paymentMethod),
        usage: c.usage == null ? null : ReceiptUsage.fromWire(c.usage!),
        meal: c.mealPartySize == null
            ? null
            : ReceiptMeal(
                partySize: c.mealPartySize!,
                participants: c.mealParticipants == null
                    ? null
                    : (jsonDecode(c.mealParticipants!) as List<dynamic>)
                        .map((e) => e as String)
                        .toList(),
              ),
        memo: c.memo,
        ocr: c.ocrDate == null && c.ocrTotalAmount == null
            ? null
            : ReceiptOcr(date: c.ocrDate, totalAmount: c.ocrTotalAmount),
        qualityFlags: c.qualityFlags == null
            ? null
            : (jsonDecode(c.qualityFlags!) as List<dynamic>)
                .map((e) => QualityFlag.fromWire(e as String))
                .toList(),
      );
}
