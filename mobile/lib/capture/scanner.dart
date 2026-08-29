import 'dart:io';

import 'package:cunning_document_scanner/cunning_document_scanner.dart';
import 'package:flutter/services.dart';
import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';

import 'ocr.dart';

/// 撮影と文字認識の実体。**プラグインに触るのはこの1枚だけ**にしておく
/// （差し替えが要るとき、アプリ側のコードを書き直さないため）。
///
/// スキャンは iOS=VisionKit / Android=ML Kit Document Scanner を同じ API で出すものを使う。
/// 台形補正・自動シャッター・切り出しは OS 側が持っているので、こちらは呼ぶだけでよい。

/// 紙面を1枚撮る。取り消されたら null。
abstract interface class ReceiptScanner {
  Future<String?> scanOne();
}

class PluginReceiptScanner implements ReceiptScanner {
  const PluginReceiptScanner();

  @override
  Future<String?> scanOne() async {
    // 1枚ずつ。まとめ撮りは月末バッチ（Issue #112 の Tier ③）でやる話で、v1 では持たない。
    final paths = await CunningDocumentScanner.getPictures(noOfPages: 1);
    if (paths == null || paths.isEmpty) return null;
    return paths.first;
  }
}

/// ML Kit の日本語認識。**下読み専用**（読み取りの正は Mac 側）。
class MlKitRecognizer implements ReceiptTextRecognizer {
  MlKitRecognizer() : _recognizer = TextRecognizer(script: TextRecognitionScript.japanese);

  final TextRecognizer _recognizer;

  @override
  Future<OcrLines> recognize(String imagePath) async {
    final result = await _recognizer.processImage(InputImage.fromFilePath(imagePath));
    // 行単位で扱う。「合計」と金額が同じ行に並ぶかどうかが解釈の手がかりなので、
    // ブロック全体を1つの文字列に潰さない。
    return [
      for (final block in result.blocks)
        for (final line in block.lines) line.text,
    ];
  }

  Future<void> dispose() => _recognizer.close();
}

/// iOS の文字認識（Apple Vision）。AppDelegate の TextRecognitionChannel を呼ぶ。
///
/// **ML Kit ではこのレシートの「2026年」が落ちて日付が取れなかった。**
/// Vision は同じ画像を1行で正しく読むので、iOS ではこちらを使う。
class VisionRecognizer implements ReceiptTextRecognizer {
  const VisionRecognizer();

  static const MethodChannel _channel = MethodChannel('kanean/ocr');

  @override
  Future<OcrLines> recognize(String imagePath) async {
    try {
      final lines = await _channel.invokeListMethod<String>('recognize', {'path': imagePath});
      return lines ?? const [];
    } on PlatformException {
      return const [];
    } on MissingPluginException {
      return const [];
    }
  }
}

/// 端末に合う認識器を選ぶ。iOS=Vision / それ以外=ML Kit。
ReceiptTextRecognizer defaultRecognizer() =>
    Platform.isIOS ? const VisionRecognizer() : MlKitRecognizer();
