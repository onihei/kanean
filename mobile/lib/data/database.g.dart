// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'database.dart';

// ignore_for_file: type=lint
class $CapturesTable extends Captures with TableInfo<$CapturesTable, Capture> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CapturesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _capturedAtMeta = const VerificationMeta(
    'capturedAt',
  );
  @override
  late final GeneratedColumn<String> capturedAt = GeneratedColumn<String>(
    'captured_at',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imagePathMeta = const VerificationMeta(
    'imagePath',
  );
  @override
  late final GeneratedColumn<String> imagePath = GeneratedColumn<String>(
    'image_path',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imageFileNameMeta = const VerificationMeta(
    'imageFileName',
  );
  @override
  late final GeneratedColumn<String> imageFileName = GeneratedColumn<String>(
    'image_file_name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imageContentTypeMeta = const VerificationMeta(
    'imageContentType',
  );
  @override
  late final GeneratedColumn<String> imageContentType = GeneratedColumn<String>(
    'image_content_type',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imageSizeBytesMeta = const VerificationMeta(
    'imageSizeBytes',
  );
  @override
  late final GeneratedColumn<int> imageSizeBytes = GeneratedColumn<int>(
    'image_size_bytes',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imageSha256Meta = const VerificationMeta(
    'imageSha256',
  );
  @override
  late final GeneratedColumn<String> imageSha256 = GeneratedColumn<String>(
    'image_sha256',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _paymentMethodMeta = const VerificationMeta(
    'paymentMethod',
  );
  @override
  late final GeneratedColumn<String> paymentMethod = GeneratedColumn<String>(
    'payment_method',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _usageMeta = const VerificationMeta('usage');
  @override
  late final GeneratedColumn<String> usage = GeneratedColumn<String>(
    'usage',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _mealPartySizeMeta = const VerificationMeta(
    'mealPartySize',
  );
  @override
  late final GeneratedColumn<int> mealPartySize = GeneratedColumn<int>(
    'meal_party_size',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _mealParticipantsMeta = const VerificationMeta(
    'mealParticipants',
  );
  @override
  late final GeneratedColumn<String> mealParticipants = GeneratedColumn<String>(
    'meal_participants',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _memoMeta = const VerificationMeta('memo');
  @override
  late final GeneratedColumn<String> memo = GeneratedColumn<String>(
    'memo',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _ocrDateMeta = const VerificationMeta(
    'ocrDate',
  );
  @override
  late final GeneratedColumn<String> ocrDate = GeneratedColumn<String>(
    'ocr_date',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _ocrTotalAmountMeta = const VerificationMeta(
    'ocrTotalAmount',
  );
  @override
  late final GeneratedColumn<int> ocrTotalAmount = GeneratedColumn<int>(
    'ocr_total_amount',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _qualityFlagsMeta = const VerificationMeta(
    'qualityFlags',
  );
  @override
  late final GeneratedColumn<String> qualityFlags = GeneratedColumn<String>(
    'quality_flags',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _deliveryStateMeta = const VerificationMeta(
    'deliveryState',
  );
  @override
  late final GeneratedColumn<String> deliveryState = GeneratedColumn<String>(
    'delivery_state',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('pending'),
  );
  static const VerificationMeta _attemptsMeta = const VerificationMeta(
    'attempts',
  );
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
    'attempts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastTriedAtMeta = const VerificationMeta(
    'lastTriedAt',
  );
  @override
  late final GeneratedColumn<String> lastTriedAt = GeneratedColumn<String>(
    'last_tried_at',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    capturedAt,
    imagePath,
    imageFileName,
    imageContentType,
    imageSizeBytes,
    imageSha256,
    paymentMethod,
    usage,
    mealPartySize,
    mealParticipants,
    memo,
    ocrDate,
    ocrTotalAmount,
    qualityFlags,
    deliveryState,
    attempts,
    lastError,
    lastTriedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'captures';
  @override
  VerificationContext validateIntegrity(
    Insertable<Capture> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('captured_at')) {
      context.handle(
        _capturedAtMeta,
        capturedAt.isAcceptableOrUnknown(data['captured_at']!, _capturedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_capturedAtMeta);
    }
    if (data.containsKey('image_path')) {
      context.handle(
        _imagePathMeta,
        imagePath.isAcceptableOrUnknown(data['image_path']!, _imagePathMeta),
      );
    } else if (isInserting) {
      context.missing(_imagePathMeta);
    }
    if (data.containsKey('image_file_name')) {
      context.handle(
        _imageFileNameMeta,
        imageFileName.isAcceptableOrUnknown(
          data['image_file_name']!,
          _imageFileNameMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_imageFileNameMeta);
    }
    if (data.containsKey('image_content_type')) {
      context.handle(
        _imageContentTypeMeta,
        imageContentType.isAcceptableOrUnknown(
          data['image_content_type']!,
          _imageContentTypeMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_imageContentTypeMeta);
    }
    if (data.containsKey('image_size_bytes')) {
      context.handle(
        _imageSizeBytesMeta,
        imageSizeBytes.isAcceptableOrUnknown(
          data['image_size_bytes']!,
          _imageSizeBytesMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_imageSizeBytesMeta);
    }
    if (data.containsKey('image_sha256')) {
      context.handle(
        _imageSha256Meta,
        imageSha256.isAcceptableOrUnknown(
          data['image_sha256']!,
          _imageSha256Meta,
        ),
      );
    } else if (isInserting) {
      context.missing(_imageSha256Meta);
    }
    if (data.containsKey('payment_method')) {
      context.handle(
        _paymentMethodMeta,
        paymentMethod.isAcceptableOrUnknown(
          data['payment_method']!,
          _paymentMethodMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_paymentMethodMeta);
    }
    if (data.containsKey('usage')) {
      context.handle(
        _usageMeta,
        usage.isAcceptableOrUnknown(data['usage']!, _usageMeta),
      );
    }
    if (data.containsKey('meal_party_size')) {
      context.handle(
        _mealPartySizeMeta,
        mealPartySize.isAcceptableOrUnknown(
          data['meal_party_size']!,
          _mealPartySizeMeta,
        ),
      );
    }
    if (data.containsKey('meal_participants')) {
      context.handle(
        _mealParticipantsMeta,
        mealParticipants.isAcceptableOrUnknown(
          data['meal_participants']!,
          _mealParticipantsMeta,
        ),
      );
    }
    if (data.containsKey('memo')) {
      context.handle(
        _memoMeta,
        memo.isAcceptableOrUnknown(data['memo']!, _memoMeta),
      );
    }
    if (data.containsKey('ocr_date')) {
      context.handle(
        _ocrDateMeta,
        ocrDate.isAcceptableOrUnknown(data['ocr_date']!, _ocrDateMeta),
      );
    }
    if (data.containsKey('ocr_total_amount')) {
      context.handle(
        _ocrTotalAmountMeta,
        ocrTotalAmount.isAcceptableOrUnknown(
          data['ocr_total_amount']!,
          _ocrTotalAmountMeta,
        ),
      );
    }
    if (data.containsKey('quality_flags')) {
      context.handle(
        _qualityFlagsMeta,
        qualityFlags.isAcceptableOrUnknown(
          data['quality_flags']!,
          _qualityFlagsMeta,
        ),
      );
    }
    if (data.containsKey('delivery_state')) {
      context.handle(
        _deliveryStateMeta,
        deliveryState.isAcceptableOrUnknown(
          data['delivery_state']!,
          _deliveryStateMeta,
        ),
      );
    }
    if (data.containsKey('attempts')) {
      context.handle(
        _attemptsMeta,
        attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    if (data.containsKey('last_tried_at')) {
      context.handle(
        _lastTriedAtMeta,
        lastTriedAt.isAcceptableOrUnknown(
          data['last_tried_at']!,
          _lastTriedAtMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Capture map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Capture(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      capturedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}captured_at'],
      )!,
      imagePath: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_path'],
      )!,
      imageFileName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_file_name'],
      )!,
      imageContentType: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_content_type'],
      )!,
      imageSizeBytes: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}image_size_bytes'],
      )!,
      imageSha256: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_sha256'],
      )!,
      paymentMethod: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payment_method'],
      )!,
      usage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}usage'],
      ),
      mealPartySize: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}meal_party_size'],
      ),
      mealParticipants: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}meal_participants'],
      ),
      memo: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}memo'],
      ),
      ocrDate: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}ocr_date'],
      ),
      ocrTotalAmount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}ocr_total_amount'],
      ),
      qualityFlags: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}quality_flags'],
      ),
      deliveryState: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}delivery_state'],
      )!,
      attempts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempts'],
      )!,
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
      lastTriedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_tried_at'],
      ),
    );
  }

  @override
  $CapturesTable createAlias(String alias) {
    return $CapturesTable(attachedDatabase, alias);
  }
}

class Capture extends DataClass implements Insertable<Capture> {
  /// ULID。画像・メタ・status の三者を結ぶ鍵（inbox 上のファイル名にもなる）。
  final String id;
  final String capturedAt;

  /// 端末内の画像の実体。送信できるまでここに置く。
  final String imagePath;
  final String imageFileName;
  final String imageContentType;
  final int imageSizeBytes;

  /// 冪等の鍵。撮影時に計算してメタに載せる。
  final String imageSha256;

  /// 現金／カード。**未選択のまま送信させない**ので nullable にしない。
  final String paymentMethod;
  final String? usage;
  final int? mealPartySize;

  /// 飲食の相手（JSON 配列）。人数だけ分かって相手が空でもよい。
  final String? mealParticipants;
  final String? memo;

  /// 端末 OCR の下読み。読めなくても撮影は成立するので nullable。
  final String? ocrDate;
  final int? ocrTotalAmount;

  /// 簡易検査の指摘（JSON 配列）。押し切られた場合も理由として残す。
  final String? qualityFlags;

  /// 'pending'（未送信）/ 'sent'（送信済み）/ 'failed'（要対応）。
  final String deliveryState;
  final int attempts;

  /// 失敗の理由。**繰り返し失敗しても件を消さない**ので、理由を持って残る。
  final String? lastError;
  final String? lastTriedAt;
  const Capture({
    required this.id,
    required this.capturedAt,
    required this.imagePath,
    required this.imageFileName,
    required this.imageContentType,
    required this.imageSizeBytes,
    required this.imageSha256,
    required this.paymentMethod,
    this.usage,
    this.mealPartySize,
    this.mealParticipants,
    this.memo,
    this.ocrDate,
    this.ocrTotalAmount,
    this.qualityFlags,
    required this.deliveryState,
    required this.attempts,
    this.lastError,
    this.lastTriedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['captured_at'] = Variable<String>(capturedAt);
    map['image_path'] = Variable<String>(imagePath);
    map['image_file_name'] = Variable<String>(imageFileName);
    map['image_content_type'] = Variable<String>(imageContentType);
    map['image_size_bytes'] = Variable<int>(imageSizeBytes);
    map['image_sha256'] = Variable<String>(imageSha256);
    map['payment_method'] = Variable<String>(paymentMethod);
    if (!nullToAbsent || usage != null) {
      map['usage'] = Variable<String>(usage);
    }
    if (!nullToAbsent || mealPartySize != null) {
      map['meal_party_size'] = Variable<int>(mealPartySize);
    }
    if (!nullToAbsent || mealParticipants != null) {
      map['meal_participants'] = Variable<String>(mealParticipants);
    }
    if (!nullToAbsent || memo != null) {
      map['memo'] = Variable<String>(memo);
    }
    if (!nullToAbsent || ocrDate != null) {
      map['ocr_date'] = Variable<String>(ocrDate);
    }
    if (!nullToAbsent || ocrTotalAmount != null) {
      map['ocr_total_amount'] = Variable<int>(ocrTotalAmount);
    }
    if (!nullToAbsent || qualityFlags != null) {
      map['quality_flags'] = Variable<String>(qualityFlags);
    }
    map['delivery_state'] = Variable<String>(deliveryState);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    if (!nullToAbsent || lastTriedAt != null) {
      map['last_tried_at'] = Variable<String>(lastTriedAt);
    }
    return map;
  }

  CapturesCompanion toCompanion(bool nullToAbsent) {
    return CapturesCompanion(
      id: Value(id),
      capturedAt: Value(capturedAt),
      imagePath: Value(imagePath),
      imageFileName: Value(imageFileName),
      imageContentType: Value(imageContentType),
      imageSizeBytes: Value(imageSizeBytes),
      imageSha256: Value(imageSha256),
      paymentMethod: Value(paymentMethod),
      usage: usage == null && nullToAbsent
          ? const Value.absent()
          : Value(usage),
      mealPartySize: mealPartySize == null && nullToAbsent
          ? const Value.absent()
          : Value(mealPartySize),
      mealParticipants: mealParticipants == null && nullToAbsent
          ? const Value.absent()
          : Value(mealParticipants),
      memo: memo == null && nullToAbsent ? const Value.absent() : Value(memo),
      ocrDate: ocrDate == null && nullToAbsent
          ? const Value.absent()
          : Value(ocrDate),
      ocrTotalAmount: ocrTotalAmount == null && nullToAbsent
          ? const Value.absent()
          : Value(ocrTotalAmount),
      qualityFlags: qualityFlags == null && nullToAbsent
          ? const Value.absent()
          : Value(qualityFlags),
      deliveryState: Value(deliveryState),
      attempts: Value(attempts),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      lastTriedAt: lastTriedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastTriedAt),
    );
  }

  factory Capture.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Capture(
      id: serializer.fromJson<String>(json['id']),
      capturedAt: serializer.fromJson<String>(json['capturedAt']),
      imagePath: serializer.fromJson<String>(json['imagePath']),
      imageFileName: serializer.fromJson<String>(json['imageFileName']),
      imageContentType: serializer.fromJson<String>(json['imageContentType']),
      imageSizeBytes: serializer.fromJson<int>(json['imageSizeBytes']),
      imageSha256: serializer.fromJson<String>(json['imageSha256']),
      paymentMethod: serializer.fromJson<String>(json['paymentMethod']),
      usage: serializer.fromJson<String?>(json['usage']),
      mealPartySize: serializer.fromJson<int?>(json['mealPartySize']),
      mealParticipants: serializer.fromJson<String?>(json['mealParticipants']),
      memo: serializer.fromJson<String?>(json['memo']),
      ocrDate: serializer.fromJson<String?>(json['ocrDate']),
      ocrTotalAmount: serializer.fromJson<int?>(json['ocrTotalAmount']),
      qualityFlags: serializer.fromJson<String?>(json['qualityFlags']),
      deliveryState: serializer.fromJson<String>(json['deliveryState']),
      attempts: serializer.fromJson<int>(json['attempts']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      lastTriedAt: serializer.fromJson<String?>(json['lastTriedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'capturedAt': serializer.toJson<String>(capturedAt),
      'imagePath': serializer.toJson<String>(imagePath),
      'imageFileName': serializer.toJson<String>(imageFileName),
      'imageContentType': serializer.toJson<String>(imageContentType),
      'imageSizeBytes': serializer.toJson<int>(imageSizeBytes),
      'imageSha256': serializer.toJson<String>(imageSha256),
      'paymentMethod': serializer.toJson<String>(paymentMethod),
      'usage': serializer.toJson<String?>(usage),
      'mealPartySize': serializer.toJson<int?>(mealPartySize),
      'mealParticipants': serializer.toJson<String?>(mealParticipants),
      'memo': serializer.toJson<String?>(memo),
      'ocrDate': serializer.toJson<String?>(ocrDate),
      'ocrTotalAmount': serializer.toJson<int?>(ocrTotalAmount),
      'qualityFlags': serializer.toJson<String?>(qualityFlags),
      'deliveryState': serializer.toJson<String>(deliveryState),
      'attempts': serializer.toJson<int>(attempts),
      'lastError': serializer.toJson<String?>(lastError),
      'lastTriedAt': serializer.toJson<String?>(lastTriedAt),
    };
  }

  Capture copyWith({
    String? id,
    String? capturedAt,
    String? imagePath,
    String? imageFileName,
    String? imageContentType,
    int? imageSizeBytes,
    String? imageSha256,
    String? paymentMethod,
    Value<String?> usage = const Value.absent(),
    Value<int?> mealPartySize = const Value.absent(),
    Value<String?> mealParticipants = const Value.absent(),
    Value<String?> memo = const Value.absent(),
    Value<String?> ocrDate = const Value.absent(),
    Value<int?> ocrTotalAmount = const Value.absent(),
    Value<String?> qualityFlags = const Value.absent(),
    String? deliveryState,
    int? attempts,
    Value<String?> lastError = const Value.absent(),
    Value<String?> lastTriedAt = const Value.absent(),
  }) => Capture(
    id: id ?? this.id,
    capturedAt: capturedAt ?? this.capturedAt,
    imagePath: imagePath ?? this.imagePath,
    imageFileName: imageFileName ?? this.imageFileName,
    imageContentType: imageContentType ?? this.imageContentType,
    imageSizeBytes: imageSizeBytes ?? this.imageSizeBytes,
    imageSha256: imageSha256 ?? this.imageSha256,
    paymentMethod: paymentMethod ?? this.paymentMethod,
    usage: usage.present ? usage.value : this.usage,
    mealPartySize: mealPartySize.present
        ? mealPartySize.value
        : this.mealPartySize,
    mealParticipants: mealParticipants.present
        ? mealParticipants.value
        : this.mealParticipants,
    memo: memo.present ? memo.value : this.memo,
    ocrDate: ocrDate.present ? ocrDate.value : this.ocrDate,
    ocrTotalAmount: ocrTotalAmount.present
        ? ocrTotalAmount.value
        : this.ocrTotalAmount,
    qualityFlags: qualityFlags.present ? qualityFlags.value : this.qualityFlags,
    deliveryState: deliveryState ?? this.deliveryState,
    attempts: attempts ?? this.attempts,
    lastError: lastError.present ? lastError.value : this.lastError,
    lastTriedAt: lastTriedAt.present ? lastTriedAt.value : this.lastTriedAt,
  );
  Capture copyWithCompanion(CapturesCompanion data) {
    return Capture(
      id: data.id.present ? data.id.value : this.id,
      capturedAt: data.capturedAt.present
          ? data.capturedAt.value
          : this.capturedAt,
      imagePath: data.imagePath.present ? data.imagePath.value : this.imagePath,
      imageFileName: data.imageFileName.present
          ? data.imageFileName.value
          : this.imageFileName,
      imageContentType: data.imageContentType.present
          ? data.imageContentType.value
          : this.imageContentType,
      imageSizeBytes: data.imageSizeBytes.present
          ? data.imageSizeBytes.value
          : this.imageSizeBytes,
      imageSha256: data.imageSha256.present
          ? data.imageSha256.value
          : this.imageSha256,
      paymentMethod: data.paymentMethod.present
          ? data.paymentMethod.value
          : this.paymentMethod,
      usage: data.usage.present ? data.usage.value : this.usage,
      mealPartySize: data.mealPartySize.present
          ? data.mealPartySize.value
          : this.mealPartySize,
      mealParticipants: data.mealParticipants.present
          ? data.mealParticipants.value
          : this.mealParticipants,
      memo: data.memo.present ? data.memo.value : this.memo,
      ocrDate: data.ocrDate.present ? data.ocrDate.value : this.ocrDate,
      ocrTotalAmount: data.ocrTotalAmount.present
          ? data.ocrTotalAmount.value
          : this.ocrTotalAmount,
      qualityFlags: data.qualityFlags.present
          ? data.qualityFlags.value
          : this.qualityFlags,
      deliveryState: data.deliveryState.present
          ? data.deliveryState.value
          : this.deliveryState,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      lastTriedAt: data.lastTriedAt.present
          ? data.lastTriedAt.value
          : this.lastTriedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Capture(')
          ..write('id: $id, ')
          ..write('capturedAt: $capturedAt, ')
          ..write('imagePath: $imagePath, ')
          ..write('imageFileName: $imageFileName, ')
          ..write('imageContentType: $imageContentType, ')
          ..write('imageSizeBytes: $imageSizeBytes, ')
          ..write('imageSha256: $imageSha256, ')
          ..write('paymentMethod: $paymentMethod, ')
          ..write('usage: $usage, ')
          ..write('mealPartySize: $mealPartySize, ')
          ..write('mealParticipants: $mealParticipants, ')
          ..write('memo: $memo, ')
          ..write('ocrDate: $ocrDate, ')
          ..write('ocrTotalAmount: $ocrTotalAmount, ')
          ..write('qualityFlags: $qualityFlags, ')
          ..write('deliveryState: $deliveryState, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('lastTriedAt: $lastTriedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    capturedAt,
    imagePath,
    imageFileName,
    imageContentType,
    imageSizeBytes,
    imageSha256,
    paymentMethod,
    usage,
    mealPartySize,
    mealParticipants,
    memo,
    ocrDate,
    ocrTotalAmount,
    qualityFlags,
    deliveryState,
    attempts,
    lastError,
    lastTriedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Capture &&
          other.id == this.id &&
          other.capturedAt == this.capturedAt &&
          other.imagePath == this.imagePath &&
          other.imageFileName == this.imageFileName &&
          other.imageContentType == this.imageContentType &&
          other.imageSizeBytes == this.imageSizeBytes &&
          other.imageSha256 == this.imageSha256 &&
          other.paymentMethod == this.paymentMethod &&
          other.usage == this.usage &&
          other.mealPartySize == this.mealPartySize &&
          other.mealParticipants == this.mealParticipants &&
          other.memo == this.memo &&
          other.ocrDate == this.ocrDate &&
          other.ocrTotalAmount == this.ocrTotalAmount &&
          other.qualityFlags == this.qualityFlags &&
          other.deliveryState == this.deliveryState &&
          other.attempts == this.attempts &&
          other.lastError == this.lastError &&
          other.lastTriedAt == this.lastTriedAt);
}

class CapturesCompanion extends UpdateCompanion<Capture> {
  final Value<String> id;
  final Value<String> capturedAt;
  final Value<String> imagePath;
  final Value<String> imageFileName;
  final Value<String> imageContentType;
  final Value<int> imageSizeBytes;
  final Value<String> imageSha256;
  final Value<String> paymentMethod;
  final Value<String?> usage;
  final Value<int?> mealPartySize;
  final Value<String?> mealParticipants;
  final Value<String?> memo;
  final Value<String?> ocrDate;
  final Value<int?> ocrTotalAmount;
  final Value<String?> qualityFlags;
  final Value<String> deliveryState;
  final Value<int> attempts;
  final Value<String?> lastError;
  final Value<String?> lastTriedAt;
  final Value<int> rowid;
  const CapturesCompanion({
    this.id = const Value.absent(),
    this.capturedAt = const Value.absent(),
    this.imagePath = const Value.absent(),
    this.imageFileName = const Value.absent(),
    this.imageContentType = const Value.absent(),
    this.imageSizeBytes = const Value.absent(),
    this.imageSha256 = const Value.absent(),
    this.paymentMethod = const Value.absent(),
    this.usage = const Value.absent(),
    this.mealPartySize = const Value.absent(),
    this.mealParticipants = const Value.absent(),
    this.memo = const Value.absent(),
    this.ocrDate = const Value.absent(),
    this.ocrTotalAmount = const Value.absent(),
    this.qualityFlags = const Value.absent(),
    this.deliveryState = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.lastTriedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CapturesCompanion.insert({
    required String id,
    required String capturedAt,
    required String imagePath,
    required String imageFileName,
    required String imageContentType,
    required int imageSizeBytes,
    required String imageSha256,
    required String paymentMethod,
    this.usage = const Value.absent(),
    this.mealPartySize = const Value.absent(),
    this.mealParticipants = const Value.absent(),
    this.memo = const Value.absent(),
    this.ocrDate = const Value.absent(),
    this.ocrTotalAmount = const Value.absent(),
    this.qualityFlags = const Value.absent(),
    this.deliveryState = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.lastTriedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       capturedAt = Value(capturedAt),
       imagePath = Value(imagePath),
       imageFileName = Value(imageFileName),
       imageContentType = Value(imageContentType),
       imageSizeBytes = Value(imageSizeBytes),
       imageSha256 = Value(imageSha256),
       paymentMethod = Value(paymentMethod);
  static Insertable<Capture> custom({
    Expression<String>? id,
    Expression<String>? capturedAt,
    Expression<String>? imagePath,
    Expression<String>? imageFileName,
    Expression<String>? imageContentType,
    Expression<int>? imageSizeBytes,
    Expression<String>? imageSha256,
    Expression<String>? paymentMethod,
    Expression<String>? usage,
    Expression<int>? mealPartySize,
    Expression<String>? mealParticipants,
    Expression<String>? memo,
    Expression<String>? ocrDate,
    Expression<int>? ocrTotalAmount,
    Expression<String>? qualityFlags,
    Expression<String>? deliveryState,
    Expression<int>? attempts,
    Expression<String>? lastError,
    Expression<String>? lastTriedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (capturedAt != null) 'captured_at': capturedAt,
      if (imagePath != null) 'image_path': imagePath,
      if (imageFileName != null) 'image_file_name': imageFileName,
      if (imageContentType != null) 'image_content_type': imageContentType,
      if (imageSizeBytes != null) 'image_size_bytes': imageSizeBytes,
      if (imageSha256 != null) 'image_sha256': imageSha256,
      if (paymentMethod != null) 'payment_method': paymentMethod,
      if (usage != null) 'usage': usage,
      if (mealPartySize != null) 'meal_party_size': mealPartySize,
      if (mealParticipants != null) 'meal_participants': mealParticipants,
      if (memo != null) 'memo': memo,
      if (ocrDate != null) 'ocr_date': ocrDate,
      if (ocrTotalAmount != null) 'ocr_total_amount': ocrTotalAmount,
      if (qualityFlags != null) 'quality_flags': qualityFlags,
      if (deliveryState != null) 'delivery_state': deliveryState,
      if (attempts != null) 'attempts': attempts,
      if (lastError != null) 'last_error': lastError,
      if (lastTriedAt != null) 'last_tried_at': lastTriedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CapturesCompanion copyWith({
    Value<String>? id,
    Value<String>? capturedAt,
    Value<String>? imagePath,
    Value<String>? imageFileName,
    Value<String>? imageContentType,
    Value<int>? imageSizeBytes,
    Value<String>? imageSha256,
    Value<String>? paymentMethod,
    Value<String?>? usage,
    Value<int?>? mealPartySize,
    Value<String?>? mealParticipants,
    Value<String?>? memo,
    Value<String?>? ocrDate,
    Value<int?>? ocrTotalAmount,
    Value<String?>? qualityFlags,
    Value<String>? deliveryState,
    Value<int>? attempts,
    Value<String?>? lastError,
    Value<String?>? lastTriedAt,
    Value<int>? rowid,
  }) {
    return CapturesCompanion(
      id: id ?? this.id,
      capturedAt: capturedAt ?? this.capturedAt,
      imagePath: imagePath ?? this.imagePath,
      imageFileName: imageFileName ?? this.imageFileName,
      imageContentType: imageContentType ?? this.imageContentType,
      imageSizeBytes: imageSizeBytes ?? this.imageSizeBytes,
      imageSha256: imageSha256 ?? this.imageSha256,
      paymentMethod: paymentMethod ?? this.paymentMethod,
      usage: usage ?? this.usage,
      mealPartySize: mealPartySize ?? this.mealPartySize,
      mealParticipants: mealParticipants ?? this.mealParticipants,
      memo: memo ?? this.memo,
      ocrDate: ocrDate ?? this.ocrDate,
      ocrTotalAmount: ocrTotalAmount ?? this.ocrTotalAmount,
      qualityFlags: qualityFlags ?? this.qualityFlags,
      deliveryState: deliveryState ?? this.deliveryState,
      attempts: attempts ?? this.attempts,
      lastError: lastError ?? this.lastError,
      lastTriedAt: lastTriedAt ?? this.lastTriedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (capturedAt.present) {
      map['captured_at'] = Variable<String>(capturedAt.value);
    }
    if (imagePath.present) {
      map['image_path'] = Variable<String>(imagePath.value);
    }
    if (imageFileName.present) {
      map['image_file_name'] = Variable<String>(imageFileName.value);
    }
    if (imageContentType.present) {
      map['image_content_type'] = Variable<String>(imageContentType.value);
    }
    if (imageSizeBytes.present) {
      map['image_size_bytes'] = Variable<int>(imageSizeBytes.value);
    }
    if (imageSha256.present) {
      map['image_sha256'] = Variable<String>(imageSha256.value);
    }
    if (paymentMethod.present) {
      map['payment_method'] = Variable<String>(paymentMethod.value);
    }
    if (usage.present) {
      map['usage'] = Variable<String>(usage.value);
    }
    if (mealPartySize.present) {
      map['meal_party_size'] = Variable<int>(mealPartySize.value);
    }
    if (mealParticipants.present) {
      map['meal_participants'] = Variable<String>(mealParticipants.value);
    }
    if (memo.present) {
      map['memo'] = Variable<String>(memo.value);
    }
    if (ocrDate.present) {
      map['ocr_date'] = Variable<String>(ocrDate.value);
    }
    if (ocrTotalAmount.present) {
      map['ocr_total_amount'] = Variable<int>(ocrTotalAmount.value);
    }
    if (qualityFlags.present) {
      map['quality_flags'] = Variable<String>(qualityFlags.value);
    }
    if (deliveryState.present) {
      map['delivery_state'] = Variable<String>(deliveryState.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (lastTriedAt.present) {
      map['last_tried_at'] = Variable<String>(lastTriedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CapturesCompanion(')
          ..write('id: $id, ')
          ..write('capturedAt: $capturedAt, ')
          ..write('imagePath: $imagePath, ')
          ..write('imageFileName: $imageFileName, ')
          ..write('imageContentType: $imageContentType, ')
          ..write('imageSizeBytes: $imageSizeBytes, ')
          ..write('imageSha256: $imageSha256, ')
          ..write('paymentMethod: $paymentMethod, ')
          ..write('usage: $usage, ')
          ..write('mealPartySize: $mealPartySize, ')
          ..write('mealParticipants: $mealParticipants, ')
          ..write('memo: $memo, ')
          ..write('ocrDate: $ocrDate, ')
          ..write('ocrTotalAmount: $ocrTotalAmount, ')
          ..write('qualityFlags: $qualityFlags, ')
          ..write('deliveryState: $deliveryState, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('lastTriedAt: $lastTriedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ReceiptStatusesTable extends ReceiptStatuses
    with TableInfo<$ReceiptStatusesTable, ReceiptStatuse> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ReceiptStatusesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _processedAtMeta = const VerificationMeta(
    'processedAt',
  );
  @override
  late final GeneratedColumn<String> processedAt = GeneratedColumn<String>(
    'processed_at',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _registeredMeta = const VerificationMeta(
    'registered',
  );
  @override
  late final GeneratedColumn<bool> registered = GeneratedColumn<bool>(
    'registered',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("registered" IN (0, 1))',
    ),
  );
  static const VerificationMeta _reasonMeta = const VerificationMeta('reason');
  @override
  late final GeneratedColumn<String> reason = GeneratedColumn<String>(
    'reason',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _detailMeta = const VerificationMeta('detail');
  @override
  late final GeneratedColumn<String> detail = GeneratedColumn<String>(
    'detail',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _summaryEntryIdMeta = const VerificationMeta(
    'summaryEntryId',
  );
  @override
  late final GeneratedColumn<int> summaryEntryId = GeneratedColumn<int>(
    'summary_entry_id',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _summaryDateMeta = const VerificationMeta(
    'summaryDate',
  );
  @override
  late final GeneratedColumn<String> summaryDate = GeneratedColumn<String>(
    'summary_date',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _summaryTotalAmountMeta =
      const VerificationMeta('summaryTotalAmount');
  @override
  late final GeneratedColumn<int> summaryTotalAmount = GeneratedColumn<int>(
    'summary_total_amount',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _summaryAccountNameMeta =
      const VerificationMeta('summaryAccountName');
  @override
  late final GeneratedColumn<String> summaryAccountName =
      GeneratedColumn<String>(
        'summary_account_name',
        aliasedName,
        true,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
      );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    processedAt,
    registered,
    reason,
    detail,
    summaryEntryId,
    summaryDate,
    summaryTotalAmount,
    summaryAccountName,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'receipt_statuses';
  @override
  VerificationContext validateIntegrity(
    Insertable<ReceiptStatuse> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('processed_at')) {
      context.handle(
        _processedAtMeta,
        processedAt.isAcceptableOrUnknown(
          data['processed_at']!,
          _processedAtMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_processedAtMeta);
    }
    if (data.containsKey('registered')) {
      context.handle(
        _registeredMeta,
        registered.isAcceptableOrUnknown(data['registered']!, _registeredMeta),
      );
    } else if (isInserting) {
      context.missing(_registeredMeta);
    }
    if (data.containsKey('reason')) {
      context.handle(
        _reasonMeta,
        reason.isAcceptableOrUnknown(data['reason']!, _reasonMeta),
      );
    }
    if (data.containsKey('detail')) {
      context.handle(
        _detailMeta,
        detail.isAcceptableOrUnknown(data['detail']!, _detailMeta),
      );
    }
    if (data.containsKey('summary_entry_id')) {
      context.handle(
        _summaryEntryIdMeta,
        summaryEntryId.isAcceptableOrUnknown(
          data['summary_entry_id']!,
          _summaryEntryIdMeta,
        ),
      );
    }
    if (data.containsKey('summary_date')) {
      context.handle(
        _summaryDateMeta,
        summaryDate.isAcceptableOrUnknown(
          data['summary_date']!,
          _summaryDateMeta,
        ),
      );
    }
    if (data.containsKey('summary_total_amount')) {
      context.handle(
        _summaryTotalAmountMeta,
        summaryTotalAmount.isAcceptableOrUnknown(
          data['summary_total_amount']!,
          _summaryTotalAmountMeta,
        ),
      );
    }
    if (data.containsKey('summary_account_name')) {
      context.handle(
        _summaryAccountNameMeta,
        summaryAccountName.isAcceptableOrUnknown(
          data['summary_account_name']!,
          _summaryAccountNameMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  ReceiptStatuse map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ReceiptStatuse(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      processedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}processed_at'],
      )!,
      registered: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}registered'],
      )!,
      reason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason'],
      ),
      detail: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}detail'],
      ),
      summaryEntryId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}summary_entry_id'],
      ),
      summaryDate: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}summary_date'],
      ),
      summaryTotalAmount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}summary_total_amount'],
      ),
      summaryAccountName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}summary_account_name'],
      ),
    );
  }

  @override
  $ReceiptStatusesTable createAlias(String alias) {
    return $ReceiptStatusesTable(attachedDatabase, alias);
  }
}

class ReceiptStatuse extends DataClass implements Insertable<ReceiptStatuse> {
  final String id;
  final String processedAt;
  final bool registered;

  /// 未登録の理由。registered=false のとき必ず入る。
  final String? reason;
  final String? detail;
  final int? summaryEntryId;
  final String? summaryDate;
  final int? summaryTotalAmount;
  final String? summaryAccountName;
  const ReceiptStatuse({
    required this.id,
    required this.processedAt,
    required this.registered,
    this.reason,
    this.detail,
    this.summaryEntryId,
    this.summaryDate,
    this.summaryTotalAmount,
    this.summaryAccountName,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['processed_at'] = Variable<String>(processedAt);
    map['registered'] = Variable<bool>(registered);
    if (!nullToAbsent || reason != null) {
      map['reason'] = Variable<String>(reason);
    }
    if (!nullToAbsent || detail != null) {
      map['detail'] = Variable<String>(detail);
    }
    if (!nullToAbsent || summaryEntryId != null) {
      map['summary_entry_id'] = Variable<int>(summaryEntryId);
    }
    if (!nullToAbsent || summaryDate != null) {
      map['summary_date'] = Variable<String>(summaryDate);
    }
    if (!nullToAbsent || summaryTotalAmount != null) {
      map['summary_total_amount'] = Variable<int>(summaryTotalAmount);
    }
    if (!nullToAbsent || summaryAccountName != null) {
      map['summary_account_name'] = Variable<String>(summaryAccountName);
    }
    return map;
  }

  ReceiptStatusesCompanion toCompanion(bool nullToAbsent) {
    return ReceiptStatusesCompanion(
      id: Value(id),
      processedAt: Value(processedAt),
      registered: Value(registered),
      reason: reason == null && nullToAbsent
          ? const Value.absent()
          : Value(reason),
      detail: detail == null && nullToAbsent
          ? const Value.absent()
          : Value(detail),
      summaryEntryId: summaryEntryId == null && nullToAbsent
          ? const Value.absent()
          : Value(summaryEntryId),
      summaryDate: summaryDate == null && nullToAbsent
          ? const Value.absent()
          : Value(summaryDate),
      summaryTotalAmount: summaryTotalAmount == null && nullToAbsent
          ? const Value.absent()
          : Value(summaryTotalAmount),
      summaryAccountName: summaryAccountName == null && nullToAbsent
          ? const Value.absent()
          : Value(summaryAccountName),
    );
  }

  factory ReceiptStatuse.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ReceiptStatuse(
      id: serializer.fromJson<String>(json['id']),
      processedAt: serializer.fromJson<String>(json['processedAt']),
      registered: serializer.fromJson<bool>(json['registered']),
      reason: serializer.fromJson<String?>(json['reason']),
      detail: serializer.fromJson<String?>(json['detail']),
      summaryEntryId: serializer.fromJson<int?>(json['summaryEntryId']),
      summaryDate: serializer.fromJson<String?>(json['summaryDate']),
      summaryTotalAmount: serializer.fromJson<int?>(json['summaryTotalAmount']),
      summaryAccountName: serializer.fromJson<String?>(
        json['summaryAccountName'],
      ),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'processedAt': serializer.toJson<String>(processedAt),
      'registered': serializer.toJson<bool>(registered),
      'reason': serializer.toJson<String?>(reason),
      'detail': serializer.toJson<String?>(detail),
      'summaryEntryId': serializer.toJson<int?>(summaryEntryId),
      'summaryDate': serializer.toJson<String?>(summaryDate),
      'summaryTotalAmount': serializer.toJson<int?>(summaryTotalAmount),
      'summaryAccountName': serializer.toJson<String?>(summaryAccountName),
    };
  }

  ReceiptStatuse copyWith({
    String? id,
    String? processedAt,
    bool? registered,
    Value<String?> reason = const Value.absent(),
    Value<String?> detail = const Value.absent(),
    Value<int?> summaryEntryId = const Value.absent(),
    Value<String?> summaryDate = const Value.absent(),
    Value<int?> summaryTotalAmount = const Value.absent(),
    Value<String?> summaryAccountName = const Value.absent(),
  }) => ReceiptStatuse(
    id: id ?? this.id,
    processedAt: processedAt ?? this.processedAt,
    registered: registered ?? this.registered,
    reason: reason.present ? reason.value : this.reason,
    detail: detail.present ? detail.value : this.detail,
    summaryEntryId: summaryEntryId.present
        ? summaryEntryId.value
        : this.summaryEntryId,
    summaryDate: summaryDate.present ? summaryDate.value : this.summaryDate,
    summaryTotalAmount: summaryTotalAmount.present
        ? summaryTotalAmount.value
        : this.summaryTotalAmount,
    summaryAccountName: summaryAccountName.present
        ? summaryAccountName.value
        : this.summaryAccountName,
  );
  ReceiptStatuse copyWithCompanion(ReceiptStatusesCompanion data) {
    return ReceiptStatuse(
      id: data.id.present ? data.id.value : this.id,
      processedAt: data.processedAt.present
          ? data.processedAt.value
          : this.processedAt,
      registered: data.registered.present
          ? data.registered.value
          : this.registered,
      reason: data.reason.present ? data.reason.value : this.reason,
      detail: data.detail.present ? data.detail.value : this.detail,
      summaryEntryId: data.summaryEntryId.present
          ? data.summaryEntryId.value
          : this.summaryEntryId,
      summaryDate: data.summaryDate.present
          ? data.summaryDate.value
          : this.summaryDate,
      summaryTotalAmount: data.summaryTotalAmount.present
          ? data.summaryTotalAmount.value
          : this.summaryTotalAmount,
      summaryAccountName: data.summaryAccountName.present
          ? data.summaryAccountName.value
          : this.summaryAccountName,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ReceiptStatuse(')
          ..write('id: $id, ')
          ..write('processedAt: $processedAt, ')
          ..write('registered: $registered, ')
          ..write('reason: $reason, ')
          ..write('detail: $detail, ')
          ..write('summaryEntryId: $summaryEntryId, ')
          ..write('summaryDate: $summaryDate, ')
          ..write('summaryTotalAmount: $summaryTotalAmount, ')
          ..write('summaryAccountName: $summaryAccountName')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    processedAt,
    registered,
    reason,
    detail,
    summaryEntryId,
    summaryDate,
    summaryTotalAmount,
    summaryAccountName,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ReceiptStatuse &&
          other.id == this.id &&
          other.processedAt == this.processedAt &&
          other.registered == this.registered &&
          other.reason == this.reason &&
          other.detail == this.detail &&
          other.summaryEntryId == this.summaryEntryId &&
          other.summaryDate == this.summaryDate &&
          other.summaryTotalAmount == this.summaryTotalAmount &&
          other.summaryAccountName == this.summaryAccountName);
}

class ReceiptStatusesCompanion extends UpdateCompanion<ReceiptStatuse> {
  final Value<String> id;
  final Value<String> processedAt;
  final Value<bool> registered;
  final Value<String?> reason;
  final Value<String?> detail;
  final Value<int?> summaryEntryId;
  final Value<String?> summaryDate;
  final Value<int?> summaryTotalAmount;
  final Value<String?> summaryAccountName;
  final Value<int> rowid;
  const ReceiptStatusesCompanion({
    this.id = const Value.absent(),
    this.processedAt = const Value.absent(),
    this.registered = const Value.absent(),
    this.reason = const Value.absent(),
    this.detail = const Value.absent(),
    this.summaryEntryId = const Value.absent(),
    this.summaryDate = const Value.absent(),
    this.summaryTotalAmount = const Value.absent(),
    this.summaryAccountName = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ReceiptStatusesCompanion.insert({
    required String id,
    required String processedAt,
    required bool registered,
    this.reason = const Value.absent(),
    this.detail = const Value.absent(),
    this.summaryEntryId = const Value.absent(),
    this.summaryDate = const Value.absent(),
    this.summaryTotalAmount = const Value.absent(),
    this.summaryAccountName = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       processedAt = Value(processedAt),
       registered = Value(registered);
  static Insertable<ReceiptStatuse> custom({
    Expression<String>? id,
    Expression<String>? processedAt,
    Expression<bool>? registered,
    Expression<String>? reason,
    Expression<String>? detail,
    Expression<int>? summaryEntryId,
    Expression<String>? summaryDate,
    Expression<int>? summaryTotalAmount,
    Expression<String>? summaryAccountName,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (processedAt != null) 'processed_at': processedAt,
      if (registered != null) 'registered': registered,
      if (reason != null) 'reason': reason,
      if (detail != null) 'detail': detail,
      if (summaryEntryId != null) 'summary_entry_id': summaryEntryId,
      if (summaryDate != null) 'summary_date': summaryDate,
      if (summaryTotalAmount != null)
        'summary_total_amount': summaryTotalAmount,
      if (summaryAccountName != null)
        'summary_account_name': summaryAccountName,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ReceiptStatusesCompanion copyWith({
    Value<String>? id,
    Value<String>? processedAt,
    Value<bool>? registered,
    Value<String?>? reason,
    Value<String?>? detail,
    Value<int?>? summaryEntryId,
    Value<String?>? summaryDate,
    Value<int?>? summaryTotalAmount,
    Value<String?>? summaryAccountName,
    Value<int>? rowid,
  }) {
    return ReceiptStatusesCompanion(
      id: id ?? this.id,
      processedAt: processedAt ?? this.processedAt,
      registered: registered ?? this.registered,
      reason: reason ?? this.reason,
      detail: detail ?? this.detail,
      summaryEntryId: summaryEntryId ?? this.summaryEntryId,
      summaryDate: summaryDate ?? this.summaryDate,
      summaryTotalAmount: summaryTotalAmount ?? this.summaryTotalAmount,
      summaryAccountName: summaryAccountName ?? this.summaryAccountName,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (processedAt.present) {
      map['processed_at'] = Variable<String>(processedAt.value);
    }
    if (registered.present) {
      map['registered'] = Variable<bool>(registered.value);
    }
    if (reason.present) {
      map['reason'] = Variable<String>(reason.value);
    }
    if (detail.present) {
      map['detail'] = Variable<String>(detail.value);
    }
    if (summaryEntryId.present) {
      map['summary_entry_id'] = Variable<int>(summaryEntryId.value);
    }
    if (summaryDate.present) {
      map['summary_date'] = Variable<String>(summaryDate.value);
    }
    if (summaryTotalAmount.present) {
      map['summary_total_amount'] = Variable<int>(summaryTotalAmount.value);
    }
    if (summaryAccountName.present) {
      map['summary_account_name'] = Variable<String>(summaryAccountName.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ReceiptStatusesCompanion(')
          ..write('id: $id, ')
          ..write('processedAt: $processedAt, ')
          ..write('registered: $registered, ')
          ..write('reason: $reason, ')
          ..write('detail: $detail, ')
          ..write('summaryEntryId: $summaryEntryId, ')
          ..write('summaryDate: $summaryDate, ')
          ..write('summaryTotalAmount: $summaryTotalAmount, ')
          ..write('summaryAccountName: $summaryAccountName, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$KaneanDatabase extends GeneratedDatabase {
  _$KaneanDatabase(QueryExecutor e) : super(e);
  $KaneanDatabaseManager get managers => $KaneanDatabaseManager(this);
  late final $CapturesTable captures = $CapturesTable(this);
  late final $ReceiptStatusesTable receiptStatuses = $ReceiptStatusesTable(
    this,
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    captures,
    receiptStatuses,
  ];
}

typedef $$CapturesTableCreateCompanionBuilder =
    CapturesCompanion Function({
      required String id,
      required String capturedAt,
      required String imagePath,
      required String imageFileName,
      required String imageContentType,
      required int imageSizeBytes,
      required String imageSha256,
      required String paymentMethod,
      Value<String?> usage,
      Value<int?> mealPartySize,
      Value<String?> mealParticipants,
      Value<String?> memo,
      Value<String?> ocrDate,
      Value<int?> ocrTotalAmount,
      Value<String?> qualityFlags,
      Value<String> deliveryState,
      Value<int> attempts,
      Value<String?> lastError,
      Value<String?> lastTriedAt,
      Value<int> rowid,
    });
typedef $$CapturesTableUpdateCompanionBuilder =
    CapturesCompanion Function({
      Value<String> id,
      Value<String> capturedAt,
      Value<String> imagePath,
      Value<String> imageFileName,
      Value<String> imageContentType,
      Value<int> imageSizeBytes,
      Value<String> imageSha256,
      Value<String> paymentMethod,
      Value<String?> usage,
      Value<int?> mealPartySize,
      Value<String?> mealParticipants,
      Value<String?> memo,
      Value<String?> ocrDate,
      Value<int?> ocrTotalAmount,
      Value<String?> qualityFlags,
      Value<String> deliveryState,
      Value<int> attempts,
      Value<String?> lastError,
      Value<String?> lastTriedAt,
      Value<int> rowid,
    });

class $$CapturesTableFilterComposer
    extends Composer<_$KaneanDatabase, $CapturesTable> {
  $$CapturesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imagePath => $composableBuilder(
    column: $table.imagePath,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageFileName => $composableBuilder(
    column: $table.imageFileName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageContentType => $composableBuilder(
    column: $table.imageContentType,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get imageSizeBytes => $composableBuilder(
    column: $table.imageSizeBytes,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageSha256 => $composableBuilder(
    column: $table.imageSha256,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get paymentMethod => $composableBuilder(
    column: $table.paymentMethod,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get usage => $composableBuilder(
    column: $table.usage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get mealPartySize => $composableBuilder(
    column: $table.mealPartySize,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get mealParticipants => $composableBuilder(
    column: $table.mealParticipants,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get memo => $composableBuilder(
    column: $table.memo,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get ocrDate => $composableBuilder(
    column: $table.ocrDate,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get ocrTotalAmount => $composableBuilder(
    column: $table.ocrTotalAmount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get qualityFlags => $composableBuilder(
    column: $table.qualityFlags,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get deliveryState => $composableBuilder(
    column: $table.deliveryState,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastTriedAt => $composableBuilder(
    column: $table.lastTriedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CapturesTableOrderingComposer
    extends Composer<_$KaneanDatabase, $CapturesTable> {
  $$CapturesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imagePath => $composableBuilder(
    column: $table.imagePath,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageFileName => $composableBuilder(
    column: $table.imageFileName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageContentType => $composableBuilder(
    column: $table.imageContentType,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get imageSizeBytes => $composableBuilder(
    column: $table.imageSizeBytes,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageSha256 => $composableBuilder(
    column: $table.imageSha256,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get paymentMethod => $composableBuilder(
    column: $table.paymentMethod,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get usage => $composableBuilder(
    column: $table.usage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get mealPartySize => $composableBuilder(
    column: $table.mealPartySize,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get mealParticipants => $composableBuilder(
    column: $table.mealParticipants,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get memo => $composableBuilder(
    column: $table.memo,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get ocrDate => $composableBuilder(
    column: $table.ocrDate,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get ocrTotalAmount => $composableBuilder(
    column: $table.ocrTotalAmount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get qualityFlags => $composableBuilder(
    column: $table.qualityFlags,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get deliveryState => $composableBuilder(
    column: $table.deliveryState,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastTriedAt => $composableBuilder(
    column: $table.lastTriedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CapturesTableAnnotationComposer
    extends Composer<_$KaneanDatabase, $CapturesTable> {
  $$CapturesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get imagePath =>
      $composableBuilder(column: $table.imagePath, builder: (column) => column);

  GeneratedColumn<String> get imageFileName => $composableBuilder(
    column: $table.imageFileName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get imageContentType => $composableBuilder(
    column: $table.imageContentType,
    builder: (column) => column,
  );

  GeneratedColumn<int> get imageSizeBytes => $composableBuilder(
    column: $table.imageSizeBytes,
    builder: (column) => column,
  );

  GeneratedColumn<String> get imageSha256 => $composableBuilder(
    column: $table.imageSha256,
    builder: (column) => column,
  );

  GeneratedColumn<String> get paymentMethod => $composableBuilder(
    column: $table.paymentMethod,
    builder: (column) => column,
  );

  GeneratedColumn<String> get usage =>
      $composableBuilder(column: $table.usage, builder: (column) => column);

  GeneratedColumn<int> get mealPartySize => $composableBuilder(
    column: $table.mealPartySize,
    builder: (column) => column,
  );

  GeneratedColumn<String> get mealParticipants => $composableBuilder(
    column: $table.mealParticipants,
    builder: (column) => column,
  );

  GeneratedColumn<String> get memo =>
      $composableBuilder(column: $table.memo, builder: (column) => column);

  GeneratedColumn<String> get ocrDate =>
      $composableBuilder(column: $table.ocrDate, builder: (column) => column);

  GeneratedColumn<int> get ocrTotalAmount => $composableBuilder(
    column: $table.ocrTotalAmount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get qualityFlags => $composableBuilder(
    column: $table.qualityFlags,
    builder: (column) => column,
  );

  GeneratedColumn<String> get deliveryState => $composableBuilder(
    column: $table.deliveryState,
    builder: (column) => column,
  );

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<String> get lastTriedAt => $composableBuilder(
    column: $table.lastTriedAt,
    builder: (column) => column,
  );
}

class $$CapturesTableTableManager
    extends
        RootTableManager<
          _$KaneanDatabase,
          $CapturesTable,
          Capture,
          $$CapturesTableFilterComposer,
          $$CapturesTableOrderingComposer,
          $$CapturesTableAnnotationComposer,
          $$CapturesTableCreateCompanionBuilder,
          $$CapturesTableUpdateCompanionBuilder,
          (Capture, BaseReferences<_$KaneanDatabase, $CapturesTable, Capture>),
          Capture,
          PrefetchHooks Function()
        > {
  $$CapturesTableTableManager(_$KaneanDatabase db, $CapturesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CapturesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CapturesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CapturesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> capturedAt = const Value.absent(),
                Value<String> imagePath = const Value.absent(),
                Value<String> imageFileName = const Value.absent(),
                Value<String> imageContentType = const Value.absent(),
                Value<int> imageSizeBytes = const Value.absent(),
                Value<String> imageSha256 = const Value.absent(),
                Value<String> paymentMethod = const Value.absent(),
                Value<String?> usage = const Value.absent(),
                Value<int?> mealPartySize = const Value.absent(),
                Value<String?> mealParticipants = const Value.absent(),
                Value<String?> memo = const Value.absent(),
                Value<String?> ocrDate = const Value.absent(),
                Value<int?> ocrTotalAmount = const Value.absent(),
                Value<String?> qualityFlags = const Value.absent(),
                Value<String> deliveryState = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> lastTriedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CapturesCompanion(
                id: id,
                capturedAt: capturedAt,
                imagePath: imagePath,
                imageFileName: imageFileName,
                imageContentType: imageContentType,
                imageSizeBytes: imageSizeBytes,
                imageSha256: imageSha256,
                paymentMethod: paymentMethod,
                usage: usage,
                mealPartySize: mealPartySize,
                mealParticipants: mealParticipants,
                memo: memo,
                ocrDate: ocrDate,
                ocrTotalAmount: ocrTotalAmount,
                qualityFlags: qualityFlags,
                deliveryState: deliveryState,
                attempts: attempts,
                lastError: lastError,
                lastTriedAt: lastTriedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String capturedAt,
                required String imagePath,
                required String imageFileName,
                required String imageContentType,
                required int imageSizeBytes,
                required String imageSha256,
                required String paymentMethod,
                Value<String?> usage = const Value.absent(),
                Value<int?> mealPartySize = const Value.absent(),
                Value<String?> mealParticipants = const Value.absent(),
                Value<String?> memo = const Value.absent(),
                Value<String?> ocrDate = const Value.absent(),
                Value<int?> ocrTotalAmount = const Value.absent(),
                Value<String?> qualityFlags = const Value.absent(),
                Value<String> deliveryState = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> lastTriedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CapturesCompanion.insert(
                id: id,
                capturedAt: capturedAt,
                imagePath: imagePath,
                imageFileName: imageFileName,
                imageContentType: imageContentType,
                imageSizeBytes: imageSizeBytes,
                imageSha256: imageSha256,
                paymentMethod: paymentMethod,
                usage: usage,
                mealPartySize: mealPartySize,
                mealParticipants: mealParticipants,
                memo: memo,
                ocrDate: ocrDate,
                ocrTotalAmount: ocrTotalAmount,
                qualityFlags: qualityFlags,
                deliveryState: deliveryState,
                attempts: attempts,
                lastError: lastError,
                lastTriedAt: lastTriedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CapturesTableProcessedTableManager =
    ProcessedTableManager<
      _$KaneanDatabase,
      $CapturesTable,
      Capture,
      $$CapturesTableFilterComposer,
      $$CapturesTableOrderingComposer,
      $$CapturesTableAnnotationComposer,
      $$CapturesTableCreateCompanionBuilder,
      $$CapturesTableUpdateCompanionBuilder,
      (Capture, BaseReferences<_$KaneanDatabase, $CapturesTable, Capture>),
      Capture,
      PrefetchHooks Function()
    >;
typedef $$ReceiptStatusesTableCreateCompanionBuilder =
    ReceiptStatusesCompanion Function({
      required String id,
      required String processedAt,
      required bool registered,
      Value<String?> reason,
      Value<String?> detail,
      Value<int?> summaryEntryId,
      Value<String?> summaryDate,
      Value<int?> summaryTotalAmount,
      Value<String?> summaryAccountName,
      Value<int> rowid,
    });
typedef $$ReceiptStatusesTableUpdateCompanionBuilder =
    ReceiptStatusesCompanion Function({
      Value<String> id,
      Value<String> processedAt,
      Value<bool> registered,
      Value<String?> reason,
      Value<String?> detail,
      Value<int?> summaryEntryId,
      Value<String?> summaryDate,
      Value<int?> summaryTotalAmount,
      Value<String?> summaryAccountName,
      Value<int> rowid,
    });

class $$ReceiptStatusesTableFilterComposer
    extends Composer<_$KaneanDatabase, $ReceiptStatusesTable> {
  $$ReceiptStatusesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get processedAt => $composableBuilder(
    column: $table.processedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get registered => $composableBuilder(
    column: $table.registered,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get detail => $composableBuilder(
    column: $table.detail,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get summaryEntryId => $composableBuilder(
    column: $table.summaryEntryId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get summaryDate => $composableBuilder(
    column: $table.summaryDate,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get summaryTotalAmount => $composableBuilder(
    column: $table.summaryTotalAmount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get summaryAccountName => $composableBuilder(
    column: $table.summaryAccountName,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ReceiptStatusesTableOrderingComposer
    extends Composer<_$KaneanDatabase, $ReceiptStatusesTable> {
  $$ReceiptStatusesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get processedAt => $composableBuilder(
    column: $table.processedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get registered => $composableBuilder(
    column: $table.registered,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get detail => $composableBuilder(
    column: $table.detail,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get summaryEntryId => $composableBuilder(
    column: $table.summaryEntryId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get summaryDate => $composableBuilder(
    column: $table.summaryDate,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get summaryTotalAmount => $composableBuilder(
    column: $table.summaryTotalAmount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get summaryAccountName => $composableBuilder(
    column: $table.summaryAccountName,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ReceiptStatusesTableAnnotationComposer
    extends Composer<_$KaneanDatabase, $ReceiptStatusesTable> {
  $$ReceiptStatusesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get processedAt => $composableBuilder(
    column: $table.processedAt,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get registered => $composableBuilder(
    column: $table.registered,
    builder: (column) => column,
  );

  GeneratedColumn<String> get reason =>
      $composableBuilder(column: $table.reason, builder: (column) => column);

  GeneratedColumn<String> get detail =>
      $composableBuilder(column: $table.detail, builder: (column) => column);

  GeneratedColumn<int> get summaryEntryId => $composableBuilder(
    column: $table.summaryEntryId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get summaryDate => $composableBuilder(
    column: $table.summaryDate,
    builder: (column) => column,
  );

  GeneratedColumn<int> get summaryTotalAmount => $composableBuilder(
    column: $table.summaryTotalAmount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get summaryAccountName => $composableBuilder(
    column: $table.summaryAccountName,
    builder: (column) => column,
  );
}

class $$ReceiptStatusesTableTableManager
    extends
        RootTableManager<
          _$KaneanDatabase,
          $ReceiptStatusesTable,
          ReceiptStatuse,
          $$ReceiptStatusesTableFilterComposer,
          $$ReceiptStatusesTableOrderingComposer,
          $$ReceiptStatusesTableAnnotationComposer,
          $$ReceiptStatusesTableCreateCompanionBuilder,
          $$ReceiptStatusesTableUpdateCompanionBuilder,
          (
            ReceiptStatuse,
            BaseReferences<
              _$KaneanDatabase,
              $ReceiptStatusesTable,
              ReceiptStatuse
            >,
          ),
          ReceiptStatuse,
          PrefetchHooks Function()
        > {
  $$ReceiptStatusesTableTableManager(
    _$KaneanDatabase db,
    $ReceiptStatusesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ReceiptStatusesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ReceiptStatusesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ReceiptStatusesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> processedAt = const Value.absent(),
                Value<bool> registered = const Value.absent(),
                Value<String?> reason = const Value.absent(),
                Value<String?> detail = const Value.absent(),
                Value<int?> summaryEntryId = const Value.absent(),
                Value<String?> summaryDate = const Value.absent(),
                Value<int?> summaryTotalAmount = const Value.absent(),
                Value<String?> summaryAccountName = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ReceiptStatusesCompanion(
                id: id,
                processedAt: processedAt,
                registered: registered,
                reason: reason,
                detail: detail,
                summaryEntryId: summaryEntryId,
                summaryDate: summaryDate,
                summaryTotalAmount: summaryTotalAmount,
                summaryAccountName: summaryAccountName,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String processedAt,
                required bool registered,
                Value<String?> reason = const Value.absent(),
                Value<String?> detail = const Value.absent(),
                Value<int?> summaryEntryId = const Value.absent(),
                Value<String?> summaryDate = const Value.absent(),
                Value<int?> summaryTotalAmount = const Value.absent(),
                Value<String?> summaryAccountName = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ReceiptStatusesCompanion.insert(
                id: id,
                processedAt: processedAt,
                registered: registered,
                reason: reason,
                detail: detail,
                summaryEntryId: summaryEntryId,
                summaryDate: summaryDate,
                summaryTotalAmount: summaryTotalAmount,
                summaryAccountName: summaryAccountName,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ReceiptStatusesTableProcessedTableManager =
    ProcessedTableManager<
      _$KaneanDatabase,
      $ReceiptStatusesTable,
      ReceiptStatuse,
      $$ReceiptStatusesTableFilterComposer,
      $$ReceiptStatusesTableOrderingComposer,
      $$ReceiptStatusesTableAnnotationComposer,
      $$ReceiptStatusesTableCreateCompanionBuilder,
      $$ReceiptStatusesTableUpdateCompanionBuilder,
      (
        ReceiptStatuse,
        BaseReferences<_$KaneanDatabase, $ReceiptStatusesTable, ReceiptStatuse>,
      ),
      ReceiptStatuse,
      PrefetchHooks Function()
    >;

class $KaneanDatabaseManager {
  final _$KaneanDatabase _db;
  $KaneanDatabaseManager(this._db);
  $$CapturesTableTableManager get captures =>
      $$CapturesTableTableManager(_db, _db.captures);
  $$ReceiptStatusesTableTableManager get receiptStatuses =>
      $$ReceiptStatusesTableTableManager(_db, _db.receiptStatuses);
}
