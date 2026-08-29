import 'dart:io';

import 'package:drift/drift.dart';

import '../data/database.dart';
import 'transport.dart';

/// 送信キューの掃き出しと、返ってきた status の取り込み。
///
/// 規律は2つだけ。
/// **失敗した件を消さない**（receipt-capture spec「失敗を黙って捨てない」）。
/// **status が返るまで登録済みにしない**（同「応答が無いものを放置しない」）。
class DeliveryService {
  DeliveryService({
    required this.db,
    required this.transport,
    this.maxAttempts = 5,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final KaneanDatabase db;
  final ReceiptTransport transport;

  /// これを超えて失敗したら「要対応」に落とす。**件は残る**（人が対処できる状態で置く）。
  final int maxAttempts;

  final DateTime Function() _now;

  /// 未送信をまとめて送る。1件の失敗で列を止めない。
  Future<DeliveryOutcome> deliverPending() async {
    if (!await transport.isAvailable()) {
      return const DeliveryOutcome(sent: 0, failed: 0, unavailable: true);
    }
    var sent = 0;
    var failed = 0;
    for (final capture in await db.pendingQueue()) {
      try {
        await transport.putPair(
          meta: KaneanDatabase.metaOf(capture),
          image: File(capture.imagePath),
        );
        await _markSent(capture.id);
        sent++;
      } catch (e) {
        await _markAttemptFailed(capture, e);
        failed++;
      }
    }
    return DeliveryOutcome(sent: sent, failed: failed, unavailable: false);
  }

  Future<void> _markSent(String id) =>
      (db.update(db.captures)..where((t) => t.id.equals(id))).write(
        CapturesCompanion(
          deliveryState: const Value('sent'),
          lastTriedAt: Value(_now().toIso8601String()),
          lastError: const Value(null),
        ),
      );

  Future<void> _markAttemptFailed(Capture capture, Object error) {
    final attempts = capture.attempts + 1;
    // 上限に達しても行は消さない。理由を持ったまま「要対応」として履歴に残す。
    final state = attempts >= maxAttempts ? 'failed' : 'pending';
    return (db.update(db.captures)..where((t) => t.id.equals(capture.id))).write(
      CapturesCompanion(
        attempts: Value(attempts),
        deliveryState: Value(state),
        lastError: Value(error.toString()),
        lastTriedAt: Value(_now().toIso8601String()),
      ),
    );
  }

  /// Mac が書き戻した status を端末へ取り込む。
  /// **端末に保存できてから**搬送上の status を消す（消してから落ちると結果が失われる）。
  Future<int> ingestStatuses() async {
    final statuses = await transport.readStatuses();
    var taken = 0;
    for (final status in statuses) {
      await db.into(db.receiptStatuses).insertOnConflictUpdate(
            ReceiptStatusesCompanion.insert(
              id: status.id,
              processedAt: status.processedAt,
              registered: status.registered,
              reason: Value(status.reason?.wire),
              detail: Value(status.detail),
              summaryEntryId: Value(status.summary?.entryId),
              summaryDate: Value(status.summary?.date),
              summaryTotalAmount: Value(status.summary?.totalAmount),
              summaryAccountName: Value(status.summary?.accountName),
            ),
          );
      await transport.deleteStatus(status.id);
      taken++;
    }
    return taken;
  }
}

class DeliveryOutcome {
  const DeliveryOutcome({
    required this.sent,
    required this.failed,
    required this.unavailable,
  });

  final int sent;
  final int failed;

  /// 搬送先が使えなかった（未サインイン等）。件は手つかずでキューに残っている。
  final bool unavailable;
}
