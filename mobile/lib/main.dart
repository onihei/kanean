import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ui/history_screen.dart';

/// Kanean のレシートキャプチャ。
///
/// スマホは**キャプチャデバイス**であって会計クライアントではない
/// （receipt-capture spec「端末は会計データを持たない」）。ここから帳簿を引く経路は作らない。
void main() {
  runApp(const ProviderScope(child: KaneanApp()));
}

class KaneanApp extends StatelessWidget {
  const KaneanApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kanean',
      // Flutter 側の組込 UI（テキスト選択メニュー・日付選択など）も日本語にする。
      // OS 提供の画面（VisionKit のスキャナ）は Info.plist の CFBundleLocalizations が効く。
      locale: const Locale('ja'),
      supportedLocales: const [Locale('ja'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1F6F5C)),
      ),
      home: const HistoryScreen(),
    );
  }
}
