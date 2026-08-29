import 'dart:convert';
import 'dart:io';

import '../contract/receipt_contract.dart';

/// 搬送層（receipt-inbox spec）。**端末と本体の間に接続は無い。**
/// 端末は inbox に書き、Mac は status に書く。読み書きの向きは一方向に固定される。
///
/// ここを1枚のインタフェースにしておくのは、Android（Google Drive のアプリ専用フォルダ）を
/// 後から足すときにアプリ側のコードを書き直さないため。契約（1件の単位・メタの内容・
/// status の意味）は変えずに、置き場の実体だけを差し替える。
abstract interface class ReceiptTransport {
  /// 搬送先が使える状態か（iCloud にサインインしていない等で false になる）。
  Future<bool> isAvailable();

  /// 1件を **画像とメタの対**として inbox へ置く。
  /// 対が揃わない状態を Mac 側に見せないため、**画像を先に置いてからメタを置く**。
  Future<void> putPair({required ReceiptMeta meta, required File image});

  /// Mac が書き戻した status を読む。まだ返っていない件は含まれない。
  Future<List<ReceiptStatus>> readStatuses();

  /// 読み終えた status を片付ける。inbox の画像を消すのは Mac 側の仕事で、端末は関与しない。
  Future<void> deleteStatus(String id);
}

/// ディレクトリ2つ（inbox / status）で成り立つ搬送の共通実装。
/// iCloud も Google Drive も「同期される1つのフォルダ」なので、置き場の解決だけが違う。
abstract class DirectoryTransport implements ReceiptTransport {
  /// 同期対象のルート。使えないときは null（サインインしていない等）。
  Future<Directory?> resolveRoot();

  Future<Directory?> _sub(String name) async {
    final root = await resolveRoot();
    if (root == null) return null;
    final dir = Directory('${root.path}/$name');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  @override
  Future<bool> isAvailable() async => (await resolveRoot()) != null;

  @override
  Future<void> putPair({required ReceiptMeta meta, required File image}) async {
    final inbox = await _sub('inbox');
    if (inbox == null) throw const TransportUnavailable();

    // 画像 → メタ の順。逆にすると、メタだけ見えて画像がまだ来ていない状態を
    // Mac 側が「壊れた件」と誤解しうる（規約上は持ち越すので実害は無いが、無駄が出る）。
    await image.copy('${inbox.path}/${meta.image.fileName}');
    final metaFile = File('${inbox.path}/${meta.metaFileName}');
    await metaFile.writeAsString(jsonEncode(meta.toJson()), flush: true);
  }

  @override
  Future<List<ReceiptStatus>> readStatuses() async {
    final dir = await _sub('status');
    if (dir == null) return const [];
    final out = <ReceiptStatus>[];
    await for (final entity in dir.list()) {
      if (entity is! File || !entity.path.endsWith('.json')) continue;
      try {
        final json = jsonDecode(await entity.readAsString()) as Map<String, dynamic>;
        out.add(ReceiptStatus.fromJson(json));
      } on FormatException {
        // 同期の途中で切れたファイルは次の機会に読む（読めないものを捨てない）。
        continue;
      }
    }
    return out;
  }

  @override
  Future<void> deleteStatus(String id) async {
    final dir = await _sub('status');
    if (dir == null) return;
    final file = File('${dir.path}/$id.json');
    if (await file.exists()) await file.delete();
  }
}

/// 搬送先が使えない（iCloud 未サインイン等）。件は消さずキューに残す。
class TransportUnavailable implements Exception {
  const TransportUnavailable();
  @override
  String toString() => 'iCloud が使えません（サインインと iCloud Drive の有効化を確認してください）';
}

/// 搬送先は使えるのに書き込みに失敗した。件はキューに残して再試行する。
class TransportFailure implements Exception {
  const TransportFailure(this.message);
  final String message;
  @override
  String toString() => message;
}
