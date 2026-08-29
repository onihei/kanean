import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:kanean/capture/quality.dart';
import 'package:kanean/contract/receipt_contract.dart';

/// 撮影直後の簡易検査（receipt-capture spec）。
/// 合成画像で「ピントが合った紙面」「ぼけた紙面」「白飛び」を作り、
/// 指摘が出るか／出ないかだけを固定する（閾値そのものは調整の余地がある）。
void main() {
  /// 文字が並んだレシートらしい紙面。輪郭が多いのでラプラシアン分散が大きい。
  img.Image sharpReceipt({int w = 400, int h = 700}) {
    final image = img.Image(width: w, height: h);
    img.fill(image, color: img.ColorRgb8(245, 245, 245));
    final rnd = Random(7);
    for (var row = 40; row < h - 40; row += 18) {
      final lineWidth = 120 + rnd.nextInt(w - 200);
      img.fillRect(
        image,
        x1: 40,
        y1: row,
        x2: 40 + lineWidth,
        y2: row + 7,
        color: img.ColorRgb8(20, 20, 20),
      );
    }
    return image;
  }

  test('ピントが合った紙面は指摘が出ない', () {
    final report = inspect(sharpReceipt());
    expect(report.isClean, isTrue, reason: report.flags.toString());
  });

  test('ぼけた紙面はブレとして指摘する', () {
    // 合成画像だと radius 6 で分散 ~200、radius 10 で ~18。閾値 120 はその間に置いてある。
    // 実機での落ち方は tasks 7.3 で較正する。
    final blurred = img.gaussianBlur(sharpReceipt(), radius: 10);
    final report = inspect(blurred);
    expect(report.flags, contains(QualityFlag.blur));
    // 同じ紙面をぼかしただけなので、分散は必ず下がる。
    expect(report.blurVariance, lessThan(inspect(sharpReceipt()).blurVariance));
  });

  test('白飛びを指摘する', () {
    final image = sharpReceipt();
    // 実際の白飛びは「文字が飲み込まれる」形で出る。同じ帯に文字が残ったまま、
    // 左側だけが反射で潰れた状態を作る（上半分を丸ごと白くするのは"余白"であって白飛びではない）。
    img.fillRect(image, x1: 0, y1: 100, x2: (image.width * 0.88).round(), y2: image.height - 100,
        color: img.ColorRgb8(255, 255, 255));
    // 右端の文字だけ生き残っている＝「その帯には本来文字がある」と分かる状態。
    img.fillRect(image, x1: image.width - 24, y1: 100, x2: image.width - 8,
        y2: image.height - 100, color: img.ColorRgb8(20, 20, 20));
    final report = inspect(image);
    // 閾値そのもの（0.45）は**実際に白飛びした写真をまだ持っていない**ので暫定。
    // 実機で1枚出たら、その値で締め直す。
    expect(report.flags, contains(QualityFlag.glare), reason: 'ratio=${report.glareRatio}');
  });

  test('余白だけの白さは白飛びにしない', () {
    // レシートの上下は普通に真っ白。ここを指摘すると毎回撮り直しを促すことになる。
    final image = sharpReceipt();
    img.fillRect(image, x1: 0, y1: 0, x2: image.width, y2: 120,
        color: img.ColorRgb8(255, 255, 255));
    expect(inspect(image).flags, isNot(contains(QualityFlag.glare)));
  });

  test('縁が濃いものは見切れとして指摘する', () {
    final image = sharpReceipt();
    // 画角から外れて、紙の外（暗い背景）が縁に写り込んだ状態。
    img.fillRect(image, x1: 0, y1: 0, x2: image.width, y2: 30, color: img.ColorRgb8(10, 10, 10));
    img.fillRect(image, x1: 0, y1: image.height - 30, x2: image.width, y2: image.height,
        color: img.ColorRgb8(10, 10, 10));
    expect(inspect(image).flags, contains(QualityFlag.cropped));
  });

  test('指摘には人に読める理由が付く', () {
    final report = inspect(img.gaussianBlur(sharpReceipt(), radius: 10));
    expect(report.reasons, isNotEmpty);
    expect(report.reasons.first, contains('ぶれ'));
  });

  test('デコードできないものは検査を諦めて素通しする', () {
    // 撮影そのものを失敗させない（読み取りの正は Mac 側）。
    final report = inspectImage(Uint8List.fromList([1, 2, 3, 4, 5]));
    expect(report.isClean, isTrue);
  });
}
