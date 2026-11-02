import * as vscode from 'vscode';

async function confirmMultiline(): Promise<boolean> {
  const send = '送信';
  const answer = await vscode.window.showWarningMessage(
    '複数行のコードです。最終行以外は、送信するとすぐに実行されます。',
    { modal: true },
    send,
  );
  return answer === send;
}

/** アクティブなターミナルへ送り、送ったかどうかを返す。誤実行を防ぐため Enter は押さず、確認はユーザーに任せる */
export async function sendToTerminal(text: string, confirm: () => Promise<boolean> = confirmMultiline): Promise<boolean> {
  if (text.includes('\n') && !(await confirm())) {
    return false;
  }
  const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Cheatsheet');
  terminal.show();
  terminal.sendText(text, false);
  return true;
}
