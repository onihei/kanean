import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:drift/drift.dart';
import 'package:path_provider/path_provider.dart';
import 'package:ulid/ulid.dart';

import '../contract/receipt_contract.dart';
import '../data/database.dart';
import 'ocr.dart';
import 'quality.dart';

/// 撮影1件を端末に記録するところまで（receipt-capture spec）。
/// 送るのは [DeliveryService] の仕事で、ここは**受理して残す**ことに徹する。
///
/// 通信の可否に関わらず受理する（圏外でも撮れる）。撮影が成立した時点で
/// 端末に行が立ち、送信は後から追いつく。

/// 検査の結果と、そのとき読めたもの。UI はこれを見せて「このまま送るか / 撮り直すか」を聞く。
class CaptureDraft {
  const CaptureDraft({
    required this.imagePath,
    required this.quality,
    required this.ocr,
  });

  final String imagePath;
  final QualityReport quality;
  final ReceiptOcr ocr;

  /// 撮り直しを促すか。促しても利用者は押し切れる（強制しない）。
  bool get shouldRetake => !quality.isClean;
}

/// 撮影時に付ける文脈。**支払手段だけは必須**で、それ以外は無くてよい。
class CaptureContext {
  const CaptureContext({
    required this.paymentMethod,
    this.usage,
    this.partySize,
    this.participants,
    this.memo,
  });

  final PaymentMethod paymentMethod;
  final ReceiptUsage? usage;
  final int? partySize;
  final List<String>? participants;
  final String? memo;
}

class CaptureService {
  CaptureService({
    required this.db,
    required this.recognizer,
    DateTime Function()? now,
    String Function()? newId,
    Future<Directory> Function()? storageDir,
  })  : _now = now ?? DateTime.now,
        // ULID の正準表記は大文字（Crockford Base32）。Dart の ulid は小文字を返すので揃える。
        // 契約のスキーマは大文字しか受け付けない（実機の1枚目がこれで弾かれるところだった）。
        _newId = newId ?? (() => Ulid().toString().toUpperCase()),
        _storageDir = storageDir ?? _appStorageDir;

  final KaneanDatabase db;
  final ReceiptTextRecognizer recognizer;
  final DateTime Function() _now;
  final String Function() _newId;

  /// 撮った画像を置く**永続**領域を返す。
  ///
  /// スキャナが返すのは一時ディレクトリで、**iOS は任意のタイミングでそこを消す**。
  /// 圏外で撮って後から送る経路（receipt-capture spec「圏外でも撮れる」）では
  /// 送信までの間に画像が消えうるので、受理の時点で自前の領域へ写す。
  final Future<Directory> Function() _storageDir;

  static Future<Directory> _appStorageDir() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/captures');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// 撮った直後の検査と下読み。**読めなくても失敗にしない**（正は Mac 側）。
  Future<CaptureDraft> inspect(String imagePath) async {
    final bytes = await File(imagePath).readAsBytes();
    final quality = inspectImage(bytes);

    ReceiptOcr ocr = const ReceiptOcr();
    try {
      final lines = await recognizer.recognize(imagePath);
      ocr = readReceipt(lines, reference: _now());
    } catch (_) {
      // 認識に失敗しても撮影は成立する。空のまま送れる。
    }
    return CaptureDraft(imagePath: imagePath, quality: quality, ocr: ocr);
  }

  /// 受理して送信待ちに積む。ここを通った時点で「撮れた」ことになる。
  Future<String> accept({
    required CaptureDraft draft,
    required CaptureContext context,
  }) async {
    final file = File(draft.imagePath);
    final bytes = await file.readAsBytes();
    final id = _newId();
    final ext = draft.imagePath.contains('.')
        ? draft.imagePath.split('.').last.toLowerCase()
        : 'jpg';

    // 一時ディレクトリのまま抱えない（消えると送信できなくなる）。
    final stored = await file.copy('${(await _storageDir()).path}/$id.$ext');

    await db.into(db.captures).insert(
          CapturesCompanion.insert(
            id: id,
            // 契約はオフセット付きの日時を要求する。ローカルの toIso8601String() は
            // オフセットを付けないので UTC に寄せて Z を付ける。
            capturedAt: _now().toUtc().toIso8601String(),
            imagePath: stored.path,
            // inbox 上では ULID を共有する対になる（画像 = {ULID}.{ext} / メタ = {ULID}.json）。
            imageFileName: '$id.$ext',
            imageContentType: _contentTypeFor(ext),
            imageSizeBytes: bytes.length,
            // 冪等の鍵。撮影時に計算してメタに載せる（design D7）。
            imageSha256: sha256.convert(bytes).toString(),
            paymentMethod: context.paymentMethod.wire,
            usage: Value(context.usage?.wire),
            mealPartySize: Value(context.partySize),
            mealParticipants: Value(
              context.participants == null || context.participants!.isEmpty
                  ? null
                  : jsonEncode(context.participants),
            ),
            memo: Value(context.memo),
            ocrDate: Value(draft.ocr.date),
            ocrTotalAmount: Value(draft.ocr.totalAmount),
            // 押し切られた場合も指摘は残す（Mac 側が読みにくさを知れる）。
            qualityFlags: Value(
              draft.quality.flags.isEmpty
                  ? null
                  : jsonEncode(draft.quality.flags.map((f) => f.wire).toList()),
            ),
          ),
        );
    return id;
  }

  static String _contentTypeFor(String ext) => switch (ext) {
        'heic' => 'image/heic',
        'heif' => 'image/heif',
        'png' => 'image/png',
        _ => 'image/jpeg',
      };
}
