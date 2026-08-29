import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:json_schema/json_schema.dart';
import 'package:kanean/contract/receipt_contract.dart';

/// 契約のゴールデンテスト（design D4）。
///
/// **TS 側の `packages/shared/src/__tests__/receiptContract.test.ts` と同じファイルを読む。**
/// 片側だけ解釈を変えるとどちらかが落ちる — これがドリフトに対する唯一の防壁。
/// 参照するのは zod から生成された JSON Schema そのもので、Dart 側の写しは作らない。
void main() {
  final contractDir = Directory('../packages/shared/contract/receipt');
  final fixturesDir = Directory('${contractDir.path}/fixtures');

  Map<String, dynamic> readJson(String path) =>
      jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;

  final manifest = readJson('${fixturesDir.path}/index.json');
  final cases = (manifest['cases'] as List<dynamic>).cast<Map<String, dynamic>>();

  final schemas = {
    'meta': JsonSchema.create(readJson('${contractDir.path}/receipt-meta.schema.json')),
    'status': JsonSchema.create(readJson('${contractDir.path}/receipt-status.schema.json')),
  };

  group('レシート契約のゴールデン', () {
    test('契約の成果物が置かれている', () {
      expect(contractDir.existsSync(), isTrue,
          reason: 'packages/shared の build:schema を回していない可能性がある');
      expect(cases, isNotEmpty);
    });

    for (final c in cases) {
      final file = c['file'] as String;
      final kind = c['kind'] as String;
      final valid = c['valid'] as bool;

      test('$file は ${valid ? '受理される' : '弾かれる'}', () {
        final json = readJson('${fixturesDir.path}/$file');
        // まず zod 由来の JSON Schema。TS 側と同じ判定になることを確かめる。
        expect(schemas[kind]!.validate(json).isValid, valid);

        if (!valid) return;
        // 次に Dart のモデル。スキーマが通るものは必ず型として読める。
        if (kind == 'meta') {
          final meta = ReceiptMeta.fromJson(json);
          expect(meta.schemaVersion, receiptSchemaVersion);
          // 往復して元の JSON と同じものに戻る＝取りこぼした項目が無い。
          expect(meta.toJson(), equals(json));
        } else {
          final status = ReceiptStatus.fromJson(json);
          expect(status.schemaVersion, receiptSchemaVersion);
          expect(status.toJson(), equals(json));
        }
      });
    }

    test('現金とカードを取り違えない', () {
      final cash = ReceiptMeta.fromJson(readJson('${fixturesDir.path}/meta-cash-full.json'));
      final card = ReceiptMeta.fromJson(readJson('${fixturesDir.path}/meta-card.json'));
      expect(cash.paymentMethod, PaymentMethod.cash);
      expect(card.paymentMethod, PaymentMethod.card);
    });

    test('未登録の status は必ず理由を持つ', () {
      for (final c in cases.where((c) => c['kind'] == 'status' && c['valid'] == true)) {
        final status = ReceiptStatus.fromJson(readJson('${fixturesDir.path}/${c['file']}'));
        if (!status.registered) expect(status.reason, isNotNull);
      }
    });

    test('登録済みの status は帳簿の中身を運ばない', () {
      final json = readJson('${fixturesDir.path}/status-registered.json');
      // 要約に許すのは entryId・date・totalAmount・accountName の4つだけ。
      final keys = (json['summary'] as Map<String, dynamic>).keys.toList()..sort();
      expect(keys, ['accountName', 'date', 'entryId', 'totalAmount']);
    });

    test('読み取れなかった項目は空のまま運べる', () {
      // 端末 OCR が読めなくても撮影は成立する（receipt-capture spec）。
      final meta = ReceiptMeta.fromJson(readJson('${fixturesDir.path}/meta-cash-minimal.json'));
      expect(meta.ocr, isNull);
      expect(meta.usage, isNull);
      expect(meta.meal, isNull);
      // 支払手段だけは欠けない。
      expect(meta.paymentMethod, PaymentMethod.cash);
    });
  });
}
