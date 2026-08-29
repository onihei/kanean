import 'dart:io';

import 'package:flutter/services.dart';

import 'dart:convert';

import '../contract/receipt_contract.dart';
import 'transport.dart';

/// iCloud Documents コンテナ（design D2 の搬送・Runner.entitlements と対）。
///
/// `NSUbiquitousContainerIsDocumentScopePublic` を立ててあるので、ここは
/// iCloud Drive の「Kanean」として**利用者にも Mac にも見えるフォルダ**になる。
/// Mac 側はこれをローカルファイルとして読むだけ — 自前のサーバも鍵管理も要らない。
///
/// 端末上の実体は `~/Library/Mobile Documents/iCloud~com~susipero~kanean~mobile/Documents/`
/// に相当する位置で、iOS では `NSFileManager.URLForUbiquityContainerIdentifier` が返す。
class ICloudTransport extends DirectoryTransport {
  ICloudTransport({this.containerId = defaultContainerId});

  /// entitlements で宣言しているコンテナ。ここを変えるときは
  /// Runner.entitlements と Info.plist の NSUbiquitousContainers も揃えること。
  static const String defaultContainerId = 'iCloud.com.susipero.kanean.mobile';

  final String containerId;

  Directory? _cached;

  /// コンテナ内の読み書きはネイティブ側で **NSFileCoordinator を通す**
  /// （AppDelegate.swift の ICloudFilesChannel）。
  ///
  /// 素のファイル API で書くと、端末にはファイルが在るのに同期デーモンが気づかず
  /// Mac へ上がってこない。しかもアプリ側は成功したつもりで「送信済み」にするので、
  /// **黙って止まる**。実機で実際にそうなった。
  static const MethodChannel _files = MethodChannel('kanean/icloud-files');

  @override
  Future<void> putPair({required ReceiptMeta meta, required File image}) async {
    final root = await resolveRoot();
    if (root == null) throw const TransportUnavailable();
    final inbox = Directory('${root.path}/inbox');
    if (!await inbox.exists()) await inbox.create(recursive: true);

    final failure = await _files.invokeMethod<String>('putPair', {
      'inbox': inbox.path,
      'imageSource': image.path,
      'imageName': meta.image.fileName,
      'metaJson': jsonEncode(meta.toJson()),
      'metaName': meta.metaFileName,
    });
    if (failure != null) throw TransportFailure(failure);
  }

  @override
  Future<List<ReceiptStatus>> readStatuses() async {
    final root = await resolveRoot();
    if (root == null) return const [];
    final dir = Directory('${root.path}/status');
    if (!await dir.exists()) await dir.create(recursive: true);

    final texts = await _files.invokeListMethod<String>('readStatuses', {'dir': dir.path});
    final out = <ReceiptStatus>[];
    for (final text in texts ?? const <String>[]) {
      try {
        out.add(ReceiptStatus.fromJson(jsonDecode(text) as Map<String, dynamic>));
      } on FormatException {
        // 同期の途中で切れたものは次の機会に読む（読めないものを捨てない）。
        continue;
      }
    }
    return out;
  }

  @override
  Future<void> deleteStatus(String id) async {
    final root = await resolveRoot();
    if (root == null) return;
    await _files.invokeMethod<String>('deleteFile', {'path': '${root.path}/status/$id.json'});
  }

  @override
  Future<Directory?> resolveRoot() async {
    if (_cached != null) return _cached;
    final path = await ubiquityDocumentsPath(containerId);
    if (path == null) return null;
    final dir = Directory(path);
    if (!await dir.exists()) await dir.create(recursive: true);
    return _cached = dir;
  }

  /// コンテナの Documents までのパスを返す（未サインイン等で使えなければ null）。
  ///
  /// テストとデスクトップ実行のために差し替えられるようにしてある。実機では
  /// プラットフォーム側が返すパスを使う。
  static Future<String?> Function(String containerId) ubiquityDocumentsPath =
      _platformUbiquityDocumentsPath;

  /// ネイティブ側（AppDelegate.swift の ICloudContainerChannel）へ聞く。
  ///
  /// **文字列でパスを組み立ててはいけない。** アプリはサンドボックスの中にいて、
  /// コンテナの場所は `FileManager.url(forUbiquityContainerIdentifier:)` しか知らない。
  static const MethodChannel _channel = MethodChannel('kanean/icloud');

  static Future<String?> _platformUbiquityDocumentsPath(String containerId) async {
    if (!Platform.isIOS && !Platform.isMacOS) return null;
    try {
      return await _channel.invokeMethod<String>(
        'ubiquityDocumentsPath',
        {'containerId': containerId},
      );
    } on PlatformException {
      // サインインしていない等。件はキューに残す（消さない）。
      return null;
    } on MissingPluginException {
      return null;
    }
  }
}
