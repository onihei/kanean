import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../capture/capture_service.dart';
import '../capture/ocr.dart';
import '../capture/scanner.dart';
import '../contract/receipt_contract.dart';
import '../transport/delivery_service.dart';
import '../transport/icloud_transport.dart';
import '../transport/transport.dart';
import 'database.dart';

/// 端末内の状態と、外に触る部品の入口（Riverpod）。
///
/// 置くのは**自分が撮ったものと送信状態**だけ。会計データを取りに行く provider は作らない
/// （receipt-capture spec「端末は会計データを持たない」）。
///
/// スキャナ・認識器・搬送はすべてインタフェース越しに差す。テストでは override して、
/// プラグインを起動せずに一連の流れを通せる。

/// 端末内 DB。
final databaseProvider = Provider<KaneanDatabase>((ref) {
  final db = KaneanDatabase();
  ref.onDispose(db.close);
  return db;
});

/// 撮影（iOS=VisionKit / Android=ML Kit Document Scanner）。
final scannerProvider = Provider<ReceiptScanner>((ref) => const PluginReceiptScanner());

/// 端末内の文字認識。下読み専用で、読み取りの正は Mac 側にある。
final recognizerProvider = Provider<ReceiptTextRecognizer>((ref) {
  final recognizer = defaultRecognizer();
  if (recognizer is MlKitRecognizer) ref.onDispose(recognizer.dispose);
  return recognizer;
});

/// 搬送先（iOS=iCloud Documents コンテナ。Android は同型の実装を後から差す）。
final transportProvider = Provider<ReceiptTransport>((ref) => ICloudTransport());

final captureServiceProvider = Provider<CaptureService>(
  (ref) => CaptureService(
    db: ref.watch(databaseProvider),
    recognizer: ref.watch(recognizerProvider),
  ),
);

final deliveryServiceProvider = Provider<DeliveryService>(
  (ref) => DeliveryService(
    db: ref.watch(databaseProvider),
    transport: ref.watch(transportProvider),
  ),
);

/// 送信待ちの列。オフラインで撮ったぶんもここに並ぶ。
final pendingQueueProvider = FutureProvider<List<Capture>>(
  (ref) => ref.watch(databaseProvider).pendingQueue(),
);

/// 履歴の1行。状態は行の有無から導く（[KaneanDatabase.stateOf]）。
typedef HistoryRow = ({Capture capture, ReceiptStatus? status, CaptureState state});

/// 読み取り履歴（新しい順）。
final historyProvider = FutureProvider<List<HistoryRow>>(
  (ref) => ref.watch(databaseProvider).history(),
);
