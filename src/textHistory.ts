import { useCallback, useState } from 'react';

/** 文本播报 / 文本提问的最近记录，保存在浏览器 localStorage，各保留 20 条 */
export type TextHistoryKind = 'broadcast' | 'question';

export interface TextHistoryEntry {
  text: string;
  at: string;
}

const TEXT_HISTORY_LIMIT = 20;
const storageKey = (kind: TextHistoryKind) => `digital-human-controller.${kind}-history.v1`;

function loadTextHistory(kind: TextHistoryKind): TextHistoryEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(kind)) ?? '[]') as unknown;
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item): item is TextHistoryEntry => typeof item?.text === 'string' && item.text.trim() !== '')
      .map((item) => ({ text: item.text, at: typeof item.at === 'string' ? item.at : '' }))
      .slice(0, TEXT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveTextHistory(kind: TextHistoryKind, list: TextHistoryEntry[]) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(list));
  } catch {
    // 浏览器不允许存储时忽略
  }
}

export function useTextHistory(kind: TextHistoryKind) {
  const [items, setItems] = useState<TextHistoryEntry[]>(() => loadTextHistory(kind));

  const update = useCallback(
    (updater: (list: TextHistoryEntry[]) => TextHistoryEntry[]) => {
      setItems((current) => {
        const next = updater(current).slice(0, TEXT_HISTORY_LIMIT);
        saveTextHistory(kind, next);
        return next;
      });
    },
    [kind],
  );

  /** 记录一条；相同文本会移到最前 */
  const add = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      update((list) => [{ text: trimmed, at: new Date().toISOString() }, ...list.filter((item) => item.text !== trimmed)]);
    },
    [update],
  );

  const remove = useCallback((text: string) => update((list) => list.filter((item) => item.text !== text)), [update]);
  const clear = useCallback(() => update(() => []), [update]);

  return { items, add, remove, clear };
}
