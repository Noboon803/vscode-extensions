import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { CheatSettings } from './command';

export interface Favorite extends CheatSettings {
  id: string;
  /** `カテゴリID/チートID` */
  key: string;
}

/** お気に入りをユーザー単位で保存する。同じチートでも設定が違えば別のお気に入りになる */
export class FavoriteStore {
  static readonly storageKey = 'cheatsheet.favorites';

  constructor(private readonly memento: vscode.Memento) {}

  list(): Favorite[] {
    // 設定を持たなかった頃の形式（`カテゴリID/チートID` の文字列）は既定の設定として読む
    return this.memento
      .get<Array<Favorite | string>>(FavoriteStore.storageKey, [])
      .map((item) => (typeof item === 'string' ? { id: item, key: item, fields: {}, techniques: {} } : item));
  }

  async add(key: string, settings: CheatSettings): Promise<Favorite> {
    const favorite: Favorite = { id: randomUUID(), key, ...settings };
    await this.memento.update(FavoriteStore.storageKey, [...this.list(), favorite]);
    return favorite;
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(FavoriteStore.storageKey, this.list().filter((favorite) => favorite.id !== id));
  }
}
