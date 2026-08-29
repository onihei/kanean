import 'dart:typed_data';

import 'package:image/image.dart' as img;

import '../contract/receipt_contract.dart';

/// 撮影直後の簡易検査（receipt-capture spec「撮影時の簡易検査」）。
///
/// **その場で撮り直せるだけの検査**であって、判定を強制しない。
/// 利用者は押し切れるし、押し切った場合も指摘は [QualityFlag] としてメタに残る
/// （後から「なぜこの画像が読みにくいのか」を Mac 側が知れる）。
///
/// 端末内で完結する純粋な画像処理なので、プラグインを介さずテストできる。

/// 検査に使う縮小後の長辺（px）。ブレ・白飛びの判定に原寸は要らないうえ、
/// 撮影のたびに走るので軽さを優先する。
const int _inspectLongSide = 512;

/// ラプラシアン分散がこれ未満ならブレとみなす。ピントが合った紙面は輪郭が多く分散が大きい。
///
/// ⚠️ この値は**実機の写真で較正していない**。合成画像では、はっきりぼけたもので 20 前後、
/// ピントが合ったもので 8000 超と桁で違うので機構としては効くが、実際の紙面・照明・
/// 端末のカメラでどこに落ちるかは実機で見るまで分からない（tasks 7.3 で確かめる）。
/// 外しても撮影は止まらない（利用者が押し切れる）ので、まずは緩めに置いてある。
const double blurVarianceThreshold = 120.0;

/// 白飛びの判定。**「明るい画素の割合」では判定できない**
/// （レシートは紙自体が白く、実機の1枚では輝度250以上が 78%・完全飽和でも 33% あった）。
/// 見るのは「文字が失われたか」＝**濃い画素が1つも無い真っ白なタイル**がどれだけあるか。
/// 検査を分けるタイルの数（横×縦）。
const int _tilesX = 8;
const int _tilesY = 12;

/// タイル内の最小輝度がこれ以上なら「濃いものが何も無い」＝潰れているとみなす。
const int _blownTileMinLuminance = 246;

/// 潰れたタイルが**文字のある領域**でこの割合を超えたら白飛びとする。
/// 余白だけの紙でも潰れたタイルは出るので、文字が1つでもあるタイルが在ることを前提にする。
const double glareBlownTileRatioThreshold = 0.45;

/// 外周のこの割合を「縁」とみなし、そこに濃い画素が多ければ見切れを疑う。
const double _edgeBandRatio = 0.03;
const double croppedInkRatioThreshold = 0.18;

/// 検査の結果。[flags] が空なら、そのまま送ってよい。
class QualityReport {
  const QualityReport({
    required this.flags,
    required this.blurVariance,
    required this.glareRatio,
    required this.edgeInkRatio,
  });

  final List<QualityFlag> flags;
  final double blurVariance;
  /// 「本来なら文字があるはずの帯」のうち、潰れて文字が失われたタイルの割合。
  final double glareRatio;
  final double edgeInkRatio;

  bool get isClean => flags.isEmpty;

  /// 撮り直しを促すときに見せる理由（人に読める1行ずつ）。
  List<String> get reasons => flags
      .map((f) => switch (f) {
            QualityFlag.blur => 'ぶれています。もう一度撮ると読み取りやすくなります',
            QualityFlag.glare => '光が反射して白く飛んでいます。角度を変えてみてください',
            QualityFlag.cropped => 'レシートが切れているかもしれません。全体が入るように撮ってください',
          })
      .toList();
}

/// 画像バイト列を検査する。デコードできない場合は検査を諦めて素通しする
/// （撮影そのものを失敗させない — 読み取りの正は Mac 側にある）。
QualityReport inspectImage(Uint8List bytes) {
  img.Image? decoded;
  try {
    decoded = img.decodeImage(bytes);
  } catch (_) {
    decoded = null;
  }
  if (decoded == null) {
    return const QualityReport(flags: [], blurVariance: 0, glareRatio: 0, edgeInkRatio: 0);
  }
  return inspect(decoded);
}

QualityReport inspect(img.Image source) {
  final small = source.width >= source.height
      ? img.copyResize(source, width: _inspectLongSide)
      : img.copyResize(source, height: _inspectLongSide);
  final gray = img.grayscale(small);

  final luma = List<int>.filled(gray.width * gray.height, 0);
  for (var y = 0; y < gray.height; y++) {
    for (var x = 0; x < gray.width; x++) {
      luma[y * gray.width + x] = gray.getPixel(x, y).r.toInt();
    }
  }

  final blurVariance = _laplacianVariance(luma, gray.width, gray.height);
  final glareRatio = _blownTileRatio(luma, gray.width, gray.height);
  final edgeInkRatio = _edgeInkRatio(luma, gray.width, gray.height);

  final flags = <QualityFlag>[
    if (blurVariance < blurVarianceThreshold) QualityFlag.blur,
    if (glareRatio > glareBlownTileRatioThreshold) QualityFlag.glare,
    if (edgeInkRatio > croppedInkRatioThreshold) QualityFlag.cropped,
  ];
  return QualityReport(
    flags: flags,
    blurVariance: blurVariance,
    glareRatio: glareRatio,
    edgeInkRatio: edgeInkRatio,
  );
}

/// ラプラシアンの分散。ピントが合っているほど輪郭の応答が強く、分散が大きくなる。
double _laplacianVariance(List<int> luma, int w, int h) {
  if (w < 3 || h < 3) return double.infinity;
  final values = <double>[];
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      final v = -4 * luma[y * w + x] +
          luma[(y - 1) * w + x] +
          luma[(y + 1) * w + x] +
          luma[y * w + (x - 1)] +
          luma[y * w + (x + 1)];
      values.add(v.toDouble());
    }
  }
  final mean = values.reduce((a, b) => a + b) / values.length;
  final sq = values.fold<double>(0, (acc, v) => acc + (v - mean) * (v - mean));
  return sq / values.length;
}

/// 「文字が失われた面積」の割合。
///
/// タイルごとに最小輝度を見て、**濃いものが1つも無い真っ白なタイル**を数える。
/// ただし紙の余白も真っ白なので、**文字を含むタイルが1つでもある行**だけを母数にする
/// ＝「本来なら文字があるはずの帯」で潰れているかを見る。文字がまったく無い写真では
/// 判定材料が無いので 0（＝指摘しない）を返す。
double _blownTileRatio(List<int> luma, int w, int h) {
  final tw = (w / _tilesX).floor();
  final th = (h / _tilesY).floor();
  if (tw < 2 || th < 2) return 0;

  var considered = 0;
  var blown = 0;
  for (var ty = 0; ty < _tilesY; ty++) {
    // 1行ぶんのタイルを先に測り、その帯に文字があるかを判定する。
    final mins = <int>[];
    var rowHasInk = false;
    for (var tx = 0; tx < _tilesX; tx++) {
      var minV = 255;
      for (var y = ty * th; y < (ty + 1) * th; y++) {
        for (var x = tx * tw; x < (tx + 1) * tw; x++) {
          final v = luma[y * w + x];
          if (v < minV) minV = v;
        }
      }
      mins.add(minV);
      if (minV < 128) rowHasInk = true;
    }
    if (!rowHasInk) continue; // 余白だけの帯は数えない
    for (final minV in mins) {
      considered++;
      if (minV >= _blownTileMinLuminance) blown++;
    }
  }
  return considered == 0 ? 0 : blown / considered;
}

/// 外周の帯に濃い画素（＝文字や紙の外）がどれだけあるか。
/// スキャナが切り出した後の画像で縁に濃さが偏るのは、レシートが画角から外れた跡。
double _edgeInkRatio(List<int> luma, int w, int h) {
  final bandX = (w * _edgeBandRatio).ceil().clamp(1, w ~/ 2);
  final bandY = (h * _edgeBandRatio).ceil().clamp(1, h ~/ 2);
  var total = 0;
  var ink = 0;
  for (var y = 0; y < h; y++) {
    final onEdgeRow = y < bandY || y >= h - bandY;
    for (var x = 0; x < w; x++) {
      if (!onEdgeRow && x >= bandX && x < w - bandX) continue;
      total++;
      if (luma[y * w + x] < 100) ink++;
    }
  }
  return total == 0 ? 0 : ink / total;
}
