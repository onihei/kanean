import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../capture/capture_service.dart';
import '../contract/receipt_contract.dart';
import '../data/database.dart';
import '../data/providers.dart';
import '../transport/delivery_service.dart';
import 'confirm_screen.dart';

/// 読み取り履歴（receipt-capture spec「読み取り履歴と登録の確認」）。
///
/// **「送信済み」と「登録済み」を別物として出す。** status が返るまでは登録されていないので、
/// そこを混ぜると「撮ったのに帳簿に無い」に気づけなくなる。
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('レシート'),
        actions: [
          IconButton(
            tooltip: '送信と受け取り',
            icon: const Icon(Icons.sync),
            onPressed: () => _sync(context, ref),
          ),
        ],
      ),
      body: history.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('読み込めません: $e')),
        data: (rows) => rows.isEmpty
            ? const _EmptyState()
            : ListView.separated(
                itemCount: rows.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, i) => _HistoryTile(row: rows[i]),
              ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _capture(context, ref),
        icon: const Icon(Icons.photo_camera),
        label: const Text('撮る'),
      ),
    );
  }

  Future<void> _capture(BuildContext context, WidgetRef ref) async {
    final scanner = ref.read(scannerProvider);
    final service = ref.read(captureServiceProvider);

    final path = await scanner.scanOne();
    if (path == null) return; // 取り消し
    final draft = await service.inspect(path);
    if (!context.mounted) return;

    final result = await Navigator.of(context).push<CaptureContext>(
      MaterialPageRoute(
        builder: (_) => ConfirmScreen(
          draft: draft,
          onRetake: () => Navigator.of(context).pop(),
        ),
      ),
    );
    if (result == null) return; // 撮り直し・取り消し

    await service.accept(draft: draft, context: result);
    ref.invalidate(historyProvider);
    // 撮影はここで成立している。送信は追いつけばよく、通信できなければキューに残るだけ。
    unawaited(_drain(ref));
  }

  /// 画面から明示的に同期する。結果を必ず人に見せる（黙って失敗させない）。
  Future<void> _sync(BuildContext context, WidgetRef ref) async {
    // await をまたいで context を触らないよう、先に取っておく。
    final messenger = ScaffoldMessenger.of(context);
    final outcome = await _drain(ref);
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          outcome.unavailable
              ? 'iCloud が使えません。サインインを確認してください（写真は残っています）'
              : '送信 ${outcome.sent} 件 / 失敗 ${outcome.failed} 件',
        ),
      ),
    );
  }

  /// 送って、返ってきた status を取り込む。context を持たないので背後でも呼べる。
  Future<DeliveryOutcome> _drain(WidgetRef ref) async {
    final delivery = ref.read(deliveryServiceProvider);
    final outcome = await delivery.deliverPending();
    await delivery.ingestStatuses();
    ref.invalidate(historyProvider);
    return outcome;
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('まだ撮っていません'),
              SizedBox(height: 8),
              Text(
                '撮った写真は iCloud 経由で Mac の Kanean に渡り、AI が読み取って仕訳にします。'
                '写真には店名・金額・撮影場所が含まれます。',
                style: TextStyle(fontSize: 12),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
}

class _HistoryTile extends StatelessWidget {
  const _HistoryTile({required this.row});

  final HistoryRow row;

  @override
  Widget build(BuildContext context) {
    final capture = row.capture;
    final status = row.status;
    final summary = status?.summary;
    return ListTile(
      leading: Icon(_icon(row.state), color: _color(context, row.state)),
      title: Text(
        summary != null
            ? '${summary.date}  ${summary.totalAmount}円  ${summary.accountName}'
            : _fallbackTitle(capture),
      ),
      subtitle: Text(_subtitle(row)),
      trailing: Text(
        capture.paymentMethod == PaymentMethod.cash.wire ? '現金' : 'カード',
        style: const TextStyle(fontSize: 12),
      ),
    );
  }

  /// 登録前の見出し。**読めなかった項目を撮影日で埋めない。**
  /// 埋めるとレシートから読んだ値のように見えてしまう（実際に「日付が正しく出ている」と
  /// 誤解させた）。読めたものだけを「下読み」と呼び、読めなかったことはそう書く。
  static String _fallbackTitle(Capture c) {
    final day = c.capturedAt.split('T').first;
    final date = c.ocrDate;
    final amount = c.ocrTotalAmount;
    if (date == null && amount == null) return '撮影 $day（日付・金額とも読み取れず）';
    final parts = [
      date ?? '日付は読み取れず',
      if (amount != null) '$amount円',
    ];
    return '${parts.join('  ')}（下読み）';
  }

  /// 状態の言葉を曖昧にしない。特に「送信済み（未登録）」を「登録済み」と書かない。
  static String _subtitle(HistoryRow row) => switch (row.state) {
        CaptureState.pending => '未送信',
        CaptureState.sent => '送信済み（未登録）',
        CaptureState.registered => '登録済み',
        CaptureState.needsAttention =>
          '要対応 — ${row.status?.detail ?? row.status?.reason?.wire ?? row.capture.lastError ?? '送信できていません'}',
      };

  static IconData _icon(CaptureState state) => switch (state) {
        CaptureState.pending => Icons.schedule,
        CaptureState.sent => Icons.cloud_upload,
        CaptureState.registered => Icons.check_circle,
        CaptureState.needsAttention => Icons.error_outline,
      };

  static Color? _color(BuildContext context, CaptureState state) => switch (state) {
        CaptureState.registered => Colors.green,
        CaptureState.needsAttention => Theme.of(context).colorScheme.error,
        _ => null,
      };
}
