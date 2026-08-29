import 'package:flutter/material.dart';

import '../capture/capture_service.dart';
import '../contract/receipt_contract.dart';

/// 撮った直後の確認（receipt-capture spec「現金とカードの分岐」「撮影時の文脈付与」）。
///
/// **支払手段を選ばないと送れない。** それ以外は全部任意で、空のまま送れる。
/// 検査の指摘は撮り直しを促すが、利用者は押し切れる。
class ConfirmScreen extends StatefulWidget {
  const ConfirmScreen({super.key, required this.draft, required this.onRetake});

  final CaptureDraft draft;

  /// 撮り直し。呼ぶと画面を閉じて撮影前へ戻る。
  ///
  /// 出すのは検査の指摘カードの中だけ。常設すると「この内容で送る」の真下に
  /// 並んで誤タップの的になるうえ、ただ戻るだけなら左上の戻るで足りる。
  final VoidCallback onRetake;

  @override
  State<ConfirmScreen> createState() => _ConfirmScreenState();
}

class _ConfirmScreenState extends State<ConfirmScreen> {
  PaymentMethod? _payment;
  ReceiptUsage _usage = ReceiptUsage.business;
  final _partySize = TextEditingController();
  final _participants = TextEditingController();
  final _memo = TextEditingController();

  @override
  void dispose() {
    _partySize.dispose();
    _participants.dispose();
    _memo.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final draft = widget.draft;
    return Scaffold(
      appBar: AppBar(title: const Text('確認')),
      // 数字キーボード（numberPad）には return キーが無い。iOS の作法として
      // 「余白を触る」「スクロールする」のどちらでも閉じられるようにしておく
      // ——これが無いと、人数を打った後キーボードを消す手段が無くなる。
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => FocusScope.of(context).unfocus(),
        child: ListView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: const EdgeInsets.all(16),
          children: [
            if (draft.shouldRetake)
              _RetakeNotice(draft: draft, onRetake: widget.onRetake),
            _OcrPreview(ocr: draft.ocr),
            const SizedBox(height: 24),

            // ここが本命。カードを現金として起票すると二重計上になるので、既定値を置かない。
            const Text('支払い', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            SegmentedButton<PaymentMethod>(
              segments: const [
                ButtonSegment(
                  value: PaymentMethod.cash,
                  label: Text('現金'),
                  icon: Icon(Icons.payments),
                ),
                ButtonSegment(
                  value: PaymentMethod.card,
                  label: Text('カード'),
                  icon: Icon(Icons.credit_card),
                ),
              ],
              selected: _payment == null ? const {} : {_payment!},
              emptySelectionAllowed: true,
              onSelectionChanged: (s) {
                _dismissKeyboard();
                setState(() => _payment = s.firstOrNull);
              },
            ),
            if (_payment == PaymentMethod.card)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'カード明細は自動で取り込まれます。この写真は証憑として突き合わせます。',
                  style: TextStyle(fontSize: 12),
                ),
              ),

            const SizedBox(height: 24),
            const Text('用途', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            SegmentedButton<ReceiptUsage>(
              segments: const [
                ButtonSegment(value: ReceiptUsage.business, label: Text('事業')),
                ButtonSegment(value: ReceiptUsage.prorated, label: Text('按分')),
                ButtonSegment(value: ReceiptUsage.private, label: Text('私用')),
              ],
              selected: {_usage},
              onSelectionChanged: (s) {
                _dismissKeyboard();
                setState(() => _usage = s.first);
              },
            ),

            const SizedBox(height: 24),
            // 交際費／会議費は1人あたり金額で分かれる。撮影時にしか取れない情報。
            const Text(
              '飲食なら（任意）',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            TextField(
              controller: _partySize,
              keyboardType: TextInputType.number,
              // numberPad には完了キーが無いので、欄の外を触ったら閉じる。
              onTapOutside: (_) => _dismissKeyboard(),
              decoration: const InputDecoration(labelText: '何人で'),
            ),
            TextField(
              controller: _participants,
              textInputAction: TextInputAction.next,
              onTapOutside: (_) => _dismissKeyboard(),
              decoration: const InputDecoration(labelText: '誰と（カンマ区切り）'),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _memo,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _dismissKeyboard(),
              onTapOutside: (_) => _dismissKeyboard(),
              decoration: const InputDecoration(labelText: '摘要（任意）'),
            ),

            const SizedBox(height: 32),
            FilledButton(
              // 支払手段が未選択のうちは押せない。
              onPressed: _payment == null ? null : _submit,
              child: const Text('この内容で送る'),
            ),
          ],
        ),
      ),
    );
  }

  /// 選択操作をしたらキーボードを引っ込める（現金/カードを押しても出たままなのは不自然）。
  void _dismissKeyboard() => FocusScope.of(context).unfocus();

  void _submit() {
    final participants = _participants.text
        .split(RegExp(r'[,、]'))
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    Navigator.of(context).pop(
      CaptureContext(
        paymentMethod: _payment!,
        usage: _usage,
        partySize: int.tryParse(_partySize.text.trim()),
        participants: participants.isEmpty ? null : participants,
        memo: _memo.text.trim().isEmpty ? null : _memo.text.trim(),
      ),
    );
  }
}

/// 撮り直しの促し。**塞がない** — 理由を見せて、それでも進める道を残す。
class _RetakeNotice extends StatelessWidget {
  const _RetakeNotice({required this.draft, required this.onRetake});

  final CaptureDraft draft;
  final VoidCallback onRetake;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final reason in draft.quality.reasons) Text('・$reason'),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: onRetake, child: const Text('撮り直す')),
            ),
          ],
        ),
      ),
    );
  }
}

/// 端末が読めた日付と金額。**その場で誤りに気づくため**だけに出す。
class _OcrPreview extends StatelessWidget {
  const _OcrPreview({required this.ocr});

  final ReceiptOcr ocr;

  @override
  Widget build(BuildContext context) {
    if (ocr.isEmpty) {
      // 読めなくても撮影は成立する。あとで Mac 側が読む。
      return const Text('日付と金額は読み取れませんでした（このまま送れます）');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('日付: ${ocr.date ?? '読み取れず'}'),
        Text(
          '合計: ${ocr.totalAmount == null ? '読み取れず' : '${ocr.totalAmount}円'}',
        ),
        const Text(
          '※ 確認用の下読みです。正しくなければそのまま送って構いません',
          style: TextStyle(fontSize: 12),
        ),
      ],
    );
  }
}
