/// レシート搬送の契約（receipt-inbox spec）の Dart 側。
///
/// **正は `packages/shared/src/receipt.ts`（zod）**で、そこから生成された
/// `packages/shared/contract/receipt/*.schema.json` が唯一の入力になる。
/// ここはその形をそのまま写した型で、`test/receipt_contract_test.dart` が
/// **TS 側と同じゴールデンフィクスチャ**を読んで両者の一致を固定する。
/// 契約を変えるときは zod → 再生成 → フィクスチャ追加 → 両側のテスト、の順に触ること。
library;

/// 契約の版。端末と Mac が独立に更新されるため、読み手が版で分岐できるようにする。
const int receiptSchemaVersion = 1;

/// 支払手段。**現金は起票し、カードは起票しない**（連携サービスの取込と二重計上しないため）。
/// 撮影の瞬間にしか安く取れないので、既定値を持たせず必ず選ばせる。
enum PaymentMethod {
  cash('cash'),
  card('card');

  const PaymentMethod(this.wire);
  final String wire;

  static PaymentMethod fromWire(String v) =>
      PaymentMethod.values.firstWhere((e) => e.wire == v);
}

/// 用途。按分の判断材料として運ぶだけで、按分計算そのものは本体側が持つ。
enum ReceiptUsage {
  business('business'),
  prorated('prorated'),
  private('private');

  const ReceiptUsage(this.wire);
  final String wire;

  static ReceiptUsage fromWire(String v) =>
      ReceiptUsage.values.firstWhere((e) => e.wire == v);
}

/// 簡易検査の指摘。押し切られた場合も理由として残す。
enum QualityFlag {
  blur('blur'),
  glare('glare'),
  cropped('cropped');

  const QualityFlag(this.wire);
  final String wire;

  static QualityFlag fromWire(String v) =>
      QualityFlag.values.firstWhere((e) => e.wire == v);
}

/// 登録しなかった理由。`unmatchedCard` はカードのレシートに対応する明細が無かった場合。
enum ReceiptSkipReason {
  duplicate('duplicate'),
  unreadable('unreadable'),
  outOfPeriod('out_of_period'),
  unmatchedCard('unmatched_card');

  const ReceiptSkipReason(this.wire);
  final String wire;

  static ReceiptSkipReason fromWire(String v) =>
      ReceiptSkipReason.values.firstWhere((e) => e.wire == v);
}

/// inbox へ置く画像そのものの素性。冪等の鍵は [sha256]。
class ReceiptImage {
  const ReceiptImage({
    required this.fileName,
    required this.contentType,
    required this.sizeBytes,
    required this.sha256,
  });

  final String fileName;
  final String contentType;
  final int sizeBytes;
  final String sha256;

  factory ReceiptImage.fromJson(Map<String, dynamic> j) => ReceiptImage(
        fileName: j['fileName'] as String,
        contentType: j['contentType'] as String,
        sizeBytes: j['sizeBytes'] as int,
        sha256: j['sha256'] as String,
      );

  Map<String, dynamic> toJson() => {
        'fileName': fileName,
        'contentType': contentType,
        'sizeBytes': sizeBytes,
        'sha256': sha256,
      };
}

/// 端末内の文字認識が読めたもの。**読み取りの正は Mac 側**なので、どちらも欠けてよい。
class ReceiptOcr {
  const ReceiptOcr({this.date, this.totalAmount});

  final String? date;
  final int? totalAmount;

  bool get isEmpty => date == null && totalAmount == null;

  factory ReceiptOcr.fromJson(Map<String, dynamic> j) => ReceiptOcr(
        date: j['date'] as String?,
        totalAmount: j['totalAmount'] as int?,
      );

  Map<String, dynamic> toJson() => {
        if (date != null) 'date': date,
        if (totalAmount != null) 'totalAmount': totalAmount,
      };
}

/// 飲食の文脈。交際費／会議費の判定は 1人あたり金額と参加者記録が要件になる。
class ReceiptMeal {
  const ReceiptMeal({required this.partySize, this.participants});

  final int partySize;
  final List<String>? participants;

  factory ReceiptMeal.fromJson(Map<String, dynamic> j) => ReceiptMeal(
        partySize: j['partySize'] as int,
        participants: (j['participants'] as List<dynamic>?)
            ?.map((e) => e as String)
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'partySize': partySize,
        if (participants != null) 'participants': participants,
      };
}

/// 画像に添えるメタ。**端末が付けた文脈をそのまま運び、解釈を含まない**。
class ReceiptMeta {
  const ReceiptMeta({
    required this.id,
    required this.capturedAt,
    required this.image,
    required this.paymentMethod,
    this.usage,
    this.meal,
    this.memo,
    this.ocr,
    this.qualityFlags,
    this.schemaVersion = receiptSchemaVersion,
  });

  final int schemaVersion;
  final String id;
  final String capturedAt;
  final ReceiptImage image;
  final PaymentMethod paymentMethod;
  final ReceiptUsage? usage;
  final ReceiptMeal? meal;
  final String? memo;
  final ReceiptOcr? ocr;
  final List<QualityFlag>? qualityFlags;

  factory ReceiptMeta.fromJson(Map<String, dynamic> j) => ReceiptMeta(
        schemaVersion: j['schemaVersion'] as int,
        id: j['id'] as String,
        capturedAt: j['capturedAt'] as String,
        image: ReceiptImage.fromJson(j['image'] as Map<String, dynamic>),
        paymentMethod: PaymentMethod.fromWire(j['paymentMethod'] as String),
        usage: j['usage'] == null ? null : ReceiptUsage.fromWire(j['usage'] as String),
        meal: j['meal'] == null
            ? null
            : ReceiptMeal.fromJson(j['meal'] as Map<String, dynamic>),
        memo: j['memo'] as String?,
        ocr: j['ocr'] == null
            ? null
            : ReceiptOcr.fromJson(j['ocr'] as Map<String, dynamic>),
        qualityFlags: (j['qualityFlags'] as List<dynamic>?)
            ?.map((e) => QualityFlag.fromWire(e as String))
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'schemaVersion': schemaVersion,
        'id': id,
        'capturedAt': capturedAt,
        'image': image.toJson(),
        'paymentMethod': paymentMethod.wire,
        if (usage != null) 'usage': usage!.wire,
        if (meal != null) 'meal': meal!.toJson(),
        if (memo != null) 'memo': memo,
        if (ocr != null) 'ocr': ocr!.toJson(),
        if (qualityFlags != null)
          'qualityFlags': qualityFlags!.map((e) => e.wire).toList(),
      };

  /// inbox 上のファイル名（画像とメタは同じ ULID を共有する）。
  String get metaFileName => '$id.json';
}

/// 登録された結果の要約。**帳簿の内容・残高・他の仕訳は運ばない**。
class ReceiptSummary {
  const ReceiptSummary({
    required this.entryId,
    required this.date,
    required this.totalAmount,
    required this.accountName,
  });

  final int entryId;
  final String date;
  final int totalAmount;
  final String accountName;

  factory ReceiptSummary.fromJson(Map<String, dynamic> j) => ReceiptSummary(
        entryId: j['entryId'] as int,
        date: j['date'] as String,
        totalAmount: j['totalAmount'] as int,
        accountName: j['accountName'] as String,
      );

  Map<String, dynamic> toJson() => {
        'entryId': entryId,
        'date': date,
        'totalAmount': totalAmount,
        'accountName': accountName,
      };
}

/// Mac 側が書き戻す status。未登録なら必ず理由が付く（黙って落とさない）。
class ReceiptStatus {
  const ReceiptStatus({
    required this.id,
    required this.processedAt,
    required this.registered,
    this.summary,
    this.reason,
    this.detail,
    this.schemaVersion = receiptSchemaVersion,
  });

  final int schemaVersion;
  final String id;
  final String processedAt;

  /// 登録できたか。false なら [reason] が必ず入る。
  final bool registered;
  final ReceiptSummary? summary;
  final ReceiptSkipReason? reason;
  final String? detail;

  factory ReceiptStatus.fromJson(Map<String, dynamic> j) {
    final outcome = j['outcome'] as String;
    if (outcome != 'registered' && outcome != 'skipped') {
      throw FormatException('未知の outcome: $outcome');
    }
    final registered = outcome == 'registered';
    if (registered && j['summary'] == null) {
      throw const FormatException('registered には summary が要る');
    }
    if (!registered && j['reason'] == null) {
      throw const FormatException('skipped には reason が要る');
    }
    return ReceiptStatus(
      schemaVersion: j['schemaVersion'] as int,
      id: j['id'] as String,
      processedAt: j['processedAt'] as String,
      registered: registered,
      summary: registered
          ? ReceiptSummary.fromJson(j['summary'] as Map<String, dynamic>)
          : null,
      reason: registered
          ? null
          : ReceiptSkipReason.fromWire(j['reason'] as String),
      detail: j['detail'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'schemaVersion': schemaVersion,
        'id': id,
        'processedAt': processedAt,
        'outcome': registered ? 'registered' : 'skipped',
        if (registered) 'summary': summary!.toJson(),
        if (!registered) 'reason': reason!.wire,
        if (detail != null) 'detail': detail,
      };
}
