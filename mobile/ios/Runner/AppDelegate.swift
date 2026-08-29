import Flutter
import UIKit
import Vision

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    ICloudContainerChannel.register(with: engineBridge.pluginRegistry)
    TextRecognitionChannel.register(with: engineBridge.pluginRegistry)
    ICloudFilesChannel.register(with: engineBridge.pluginRegistry)
  }
}

/// iCloud Documents コンテナの実パスを返すだけのチャネル（receipt-inbox spec の搬送先）。
///
/// アプリはサンドボックスの中にいるので、`~/Library/Mobile Documents/...` を文字列で
/// 組み立てても届かない。**コンテナの場所は FileManager にしか分からない**ので、
/// ここだけネイティブを通す。以後の読み書きは Dart 側の普通のファイル操作でよい。
enum ICloudContainerChannel {
  static let name = "kanean/icloud"

  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "ICloudContainerChannel")?.messenger()
    else { return }
    let channel = FlutterMethodChannel(name: name, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "ubiquityDocumentsPath" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let containerId = (call.arguments as? [String: Any])?["containerId"] as? String

      // URLForUbiquityContainerIdentifier は初回にネットワークを伴うことがあり、
      // メインスレッドで呼ぶとフリーズしうる（Apple のドキュメントが背景実行を指示している）。
      DispatchQueue.global(qos: .userInitiated).async {
        let base = FileManager.default.url(forUbiquityContainerIdentifier: containerId)
        let documents = base?.appendingPathComponent("Documents")
        if let documents {
          // 初回はまだ実体が無い。作れなくても失敗にはせず、パスだけ返して Dart 側に委ねる。
          try? FileManager.default.createDirectory(
            at: documents, withIntermediateDirectories: true)
        }
        DispatchQueue.main.async {
          // nil = iCloud にサインインしていない / Drive が無効。件はキューに残す。
          result(documents?.path)
        }
      }
    }
  }
}

/// iCloud コンテナへの読み書き（receipt-inbox spec の搬送）。
///
/// **素のファイル API で書いてはいけない。** コンテナ内の変更は `NSFileCoordinator` を
/// 通して初めて同期デーモンに伝わる。Dart から直接書いていたときは、端末には
/// ファイルが在るのに Mac へ上がってこなかった（アプリは書けたつもりで「送信済み」に
/// なるので、黙って止まる質の悪い壊れ方をする）。
///
/// 逆向きも同じで、Mac が書いた status は**まだ実体が降りていない**ことがある
/// （ディレクトリには `.名前.icloud` のプレースホルダだけが在る）。読む前に
/// ダウンロードを促し、調整付きで読む。
enum ICloudFilesChannel {
  static let name = "kanean/icloud-files"

  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "ICloudFilesChannel")?.messenger()
    else { return }
    let channel = FlutterMethodChannel(name: name, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      let args = call.arguments as? [String: Any] ?? [:]
      DispatchQueue.global(qos: .userInitiated).async {
        let reply: Any?
        switch call.method {
        case "putPair":
          reply = putPair(
            inbox: args["inbox"] as? String ?? "",
            imageSource: args["imageSource"] as? String ?? "",
            imageName: args["imageName"] as? String ?? "",
            metaJson: args["metaJson"] as? String ?? "",
            metaName: args["metaName"] as? String ?? "")
        case "readStatuses":
          reply = readStatuses(dir: args["dir"] as? String ?? "")
        case "deleteFile":
          reply = deleteFile(path: args["path"] as? String ?? "")
        default:
          DispatchQueue.main.async { result(FlutterMethodNotImplemented) }
          return
        }
        DispatchQueue.main.async { result(reply) }
      }
    }
  }

  /// 画像 → メタ の順で置く。対が揃わない状態を Mac に見せないため順序は変えない。
  /// 失敗したら理由の文字列を返す（nil = 成功）。
  private static func putPair(
    inbox: String, imageSource: String, imageName: String,
    metaJson: String, metaName: String
  ) -> String? {
    let inboxURL = URL(fileURLWithPath: inbox)
    let coordinator = NSFileCoordinator()
    var failure: String?

    var error: NSError?
    coordinator.coordinate(
      writingItemAt: inboxURL.appendingPathComponent(imageName), options: .forReplacing,
      error: &error
    ) { dest in
      do {
        if FileManager.default.fileExists(atPath: dest.path) {
          try FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.copyItem(at: URL(fileURLWithPath: imageSource), to: dest)
      } catch {
        failure = "画像を置けませんでした: \(error.localizedDescription)"
      }
    }
    if let error { return "画像の調整に失敗: \(error.localizedDescription)" }
    if let failure { return failure }

    var metaError: NSError?
    coordinator.coordinate(
      writingItemAt: inboxURL.appendingPathComponent(metaName), options: .forReplacing,
      error: &metaError
    ) { dest in
      do {
        try Data(metaJson.utf8).write(to: dest, options: .atomic)
      } catch {
        failure = "メタを置けませんでした: \(error.localizedDescription)"
      }
    }
    if let metaError { return "メタの調整に失敗: \(metaError.localizedDescription)" }
    return failure
  }

  /// status を読む。**実体が降りていないものはダウンロードを促して、次の機会に回す**
  /// （待たない。読めなかったものを捨てないのが規約）。
  private static func readStatuses(dir: String) -> [String] {
    let dirURL = URL(fileURLWithPath: dir)
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(
      at: dirURL, includingPropertiesForKeys: [.isUbiquitousItemKey], options: [])
    else { return [] }

    var out: [String] = []
    for entry in entries {
      // 未ダウンロードは ".名前.icloud" というプレースホルダで現れる。
      if entry.lastPathComponent.hasSuffix(".icloud") {
        try? fm.startDownloadingUbiquitousItem(at: entry)
        continue
      }
      guard entry.pathExtension == "json" else { continue }
      var readError: NSError?
      NSFileCoordinator().coordinate(readingItemAt: entry, options: [], error: &readError) { url in
        if let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) {
          out.append(text)
        }
      }
    }
    return out
  }

  private static func deleteFile(path: String) -> String? {
    var error: NSError?
    var failure: String?
    NSFileCoordinator().coordinate(
      writingItemAt: URL(fileURLWithPath: path), options: .forDeleting, error: &error
    ) { url in
      do { try FileManager.default.removeItem(at: url) } catch {
        failure = error.localizedDescription
      }
    }
    return error?.localizedDescription ?? failure
  }
}

/// 文字の下読み（receipt-capture spec「日付と金額をその場で見せる」）。
///
/// iOS は **Apple Vision** を使う。ML Kit の日本語モデルは、実機で撮った感熱レシートで
/// 「2026年」を落として日付が取れなかった（Vision は同じ画像を1行で正しく読む）。
/// Android は ML Kit のまま — Vision は iOS にしか無い。
///
/// ここが返すのは行の配列だけで、日付と金額の解釈は Dart 側（ocr.dart）が持つ。
/// **読み取りの正は Mac 側**なので、失敗しても空を返して撮影は成立させる。
enum TextRecognitionChannel {
  static let name = "kanean/ocr"

  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "TextRecognitionChannel")?.messenger()
    else { return }
    let channel = FlutterMethodChannel(name: name, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "recognize",
            let path = (call.arguments as? [String: Any])?["path"] as? String
      else {
        result(FlutterMethodNotImplemented)
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        let lines = recognize(path: path)
        DispatchQueue.main.async { result(lines) }
      }
    }
  }

  private static func recognize(path: String) -> [String] {
    guard let image = UIImage(contentsOfFile: path), let cgImage = image.cgImage else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.recognitionLevel = .accurate
    // レシートは語彙が辞書に無いものだらけ。補正させると金額や店名が化ける。
    request.usesLanguageCorrection = false
    do {
      try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    } catch {
      return []
    }
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  }
}
