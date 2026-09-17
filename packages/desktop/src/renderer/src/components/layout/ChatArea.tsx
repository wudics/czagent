import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { MessageItem } from '../chat/MessageItem';
import { ScrollBottomButton } from '../chat/ScrollBottomButton';
import { StatusBanner } from '../chat/StatusBanner';
import { PermissionCard } from '../chat/PermissionCard';
import { QuestionCard } from '../chat/QuestionCard';
import { chatLoadConfig } from '../../stores/chat';

const NEAR_BOTTOM_PX = 150;
/** 占位块/未测量项的高度估算（与虚拟列表 estimateSize 一致） */
const ESTIMATED_ITEM_SIZE = 96;
/** 触发上拉预载的概念距离（距占位区边界/列表顶 4 项内） */
const LOAD_AHEAD_ITEMS = 4;
/** 下拉销毁的安全缓冲（渲染窗口 overscan 10 + 余量），被删区必须完全在其之外 */
const DROP_SAFE_BUFFER = 12;

export function ChatArea() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const { messages, droppedCount, hasMoreTop, loadingTop, lastTopShift, replying, open, loadMoreTop } =
    useChatStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  // following 的同步镜像：钉底循环/滚动手势在回调里读取，避免订阅时序问题
  const followingRef = useRef(true);
  // 进入会话的强制钉底阶段：位置漂移不参与解钉判定，仅滚轮/触屏手势可打断
  const enteringRef = useRef(false);
  const setPinned = (v: boolean): void => {
    followingRef.current = v;
    setFollowing(v);
  };
  const prevStartRef = useRef<number | null>(null);

  const count = droppedCount + messages.length;
  const hasMessages = count > 0;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ITEM_SIZE,
    overscan: 10,
    getItemKey: (index) => {
      if (index < droppedCount) return `drop:${index}`;
      return messages[index - droppedCount]?.id ?? `msg:${index}`;
    },
  });

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // 切换会话 → 打开并回到底部；无激活会话（如删除最后一个）→ 清空回到空状态
  useEffect(() => {
    if (activeId) {
      setPinned(true);
      // 开始进入阶段：强制钉底直至高度稳定（轮询结束/手势打断时退出）
      enteringRef.current = true;
      void open(activeId);
    } else {
      enteringRef.current = false;
      useChatStore.getState().reset();
    }
  }, [activeId]);

  // 跟随底部（仅在 following 时）：进入阶段用绝对拉底（不依赖虚拟列表的尺寸快照，
  // 避免 stale offset 落点偏短触发"距底>150px"误判），其余场景用 scrollToIndex 处理动态测量后的布局
  useEffect(() => {
    if (!following || count === 0) return;
    const id = window.setTimeout(() => {
      // 回调时可能已被用户手势解钉（wheel/touch 立即置 false），再校验一次避免把用户拽回底部
      if (!followingRef.current) return;
      const el = scrollRef.current;
      if (el && enteringRef.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        virtualizer.scrollToIndex(count - 1, { align: 'end' });
      }
    }, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, droppedCount, replying, following, totalSize, count]);

  // 会话打开后：强制钉底直到高度测量稳定（进入阶段）。
  // 消息真实高度是异步的（虚拟列表 measureElement + markdown worker 60ms 防抖 + 图片解码），
  // 固定延时的有限重试赌不过渲染窗口——高度增长使视口漂移，漂移超 150px 还会误判解钉永久停钉。
  // 改为轮询至高度稳定：绝对拉底不依赖估算尺寸，期间 handleScroll 跳过位置解钉（手势仍可打断）。
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || !hasMessages) {
      // 消息尚未真正载入（open() 的 reset 清空了旧会话残留）→ 允许载入后重启钉底
      openedRef.current = null;
      return;
    }
    if (openedRef.current === activeId) return;
    openedRef.current = activeId;
    enteringRef.current = true;
    const startedAt = Date.now();
    let ticks = 0;
    let stable = 0;
    let reconfirmed = false;
    let lastHeight = -1;
    let timer = 0;
    const finish = (): void => {
      window.clearInterval(timer);
      enteringRef.current = false;
    };
    timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 50) return finish(); // 5s 硬上限
      const el = scrollRef.current;
      // 用户手势解钉 / 已切走会话 → 立即停止钉底
      if (!el || !followingRef.current || useChatStore.getState().sessionId !== activeId) {
        return finish();
      }
      if (el.scrollHeight !== lastHeight) {
        lastHeight = el.scrollHeight;
        stable = 0;
        reconfirmed = false;
        el.scrollTop = el.scrollHeight; // 绝对底部，不依赖虚拟列表的估算尺寸
      } else {
        stable += 1;
        // 至少钉底 500ms 且连续 2 拍（200ms）高度不变，再延迟一拍复查（兜底图片解码等慢资源）后才交还常规跟随
        if (stable >= 2 && Date.now() - startedAt >= 500) {
          if (reconfirmed) finish();
          else reconfirmed = true;
        }
      }
    }, 100);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, hasMessages]);

  // 滚动到占位区/顶部附近 → 预加载上一页（按"距占位区边界的真实消息数"计算，
  // 而非概念索引：否则下拉销毁产生的占位区要一路滚穿才触发，出现大片"正在加载历史…"）
  useEffect(() => {
    const first = items[0];
    if (!first) return;
    if (first.index - droppedCount <= LOAD_AHEAD_ITEMS && (hasMoreTop || droppedCount > 0) && !loadingTop) {
      prevStartRef.current = first.index;
      void loadMoreTop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items[0]?.index, hasMoreTop, droppedCount, loadingTop]);

  // 加载完成后锚定原位置（概念索引稳定，位移补偿）
  useEffect(() => {
    if (lastTopShift > 0 && prevStartRef.current !== null) {
      const target = prevStartRef.current + lastTopShift;
      prevStartRef.current = null;
      useChatStore.setState({ lastTopShift: 0 });
      virtualizer.scrollToIndex(target, { align: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTopShift]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    // 进入阶段：强制钉底，位置漂移不参与解钉判定（手势在 wheel/touch 处理器中打断）
    if (enteringRef.current) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setPinned(near);
    if (!near) {
      // 向下滚动远离顶部时释放资源（决策 14：向下滚动释放资源）
      const first = virtualizer.getVirtualItems()[0];
      if (first && first.index > DROP_SAFE_BUFFER) {
        const st = useChatStore.getState();
        const { keep } = chatLoadConfig();
        const excess = st.messages.length - keep;
        if (excess > 0) {
          // 只删渲染窗口（含 overscan）之外的最旧消息：可见/即将可见的内容永不被销毁
          const safe = first.index - DROP_SAFE_BUFFER - st.droppedCount;
          const drop = Math.min(excess, safe);
          if (drop > 0) {
            // 补偿被删项的"实测高 − 占位估算"差值：删除后其余项的上移量恰等于该差值，
            // 同步回退 scrollTop 保持视口纹丝不动（否则会瞬间跳过被删区域的内容）
            let delta = 0;
            for (let i = 0; i < drop; i++) {
              const msg = st.messages[i];
              const measured = msg ? virtualizer.measurementsCache[st.droppedCount + i] : undefined;
              if (measured && measured.key === msg!.id) delta += measured.size - ESTIMATED_ITEM_SIZE;
            }
            st.dropOldest(drop);
            el.scrollTop = Math.max(0, el.scrollTop - delta);
          }
        }
      }
    }
  };

  // 意图判钉：向上滚动手势（滚轮 deltaY<0 / 触屏手指下滑）立即解除跟随（含打断进入阶段的强制钉底）。
  // 不依赖"距底>150px"的位置阈值——流式输出每次拉底都会清零距离，慢滚永远追不出阈值（拉锯竞态）。
  const handleWheel = (e: React.WheelEvent): void => {
    if (e.deltaY < 0 && followingRef.current) {
      enteringRef.current = false;
      setPinned(false);
    }
  };
  const touchYRef = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent): void => {
    touchYRef.current = e.touches[0]?.clientY ?? null;
  };
  const handleTouchMove = (e: React.TouchEvent): void => {
    const y = e.touches[0]?.clientY;
    if (y == null || touchYRef.current == null) return;
    if (y > touchYRef.current && followingRef.current) {
      enteringRef.current = false;
      setPinned(false);
    }
    touchYRef.current = y;
  };

  const jumpToBottom = (): void => {
    setPinned(true);
    virtualizer.scrollToIndex(Math.max(0, count - 1), { align: 'end' });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto"
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      >
        {count === 0 && !replying ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
              <MessageSquare size={22} className="text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{t('chat.emptyTitle')}</p>
            <p className="max-w-xs text-xs text-muted-foreground">{t('chat.emptyHint')}</p>
          </div>
        ) : (
          <div className="relative mx-auto max-w-3xl px-4 py-4" style={{ height: totalSize }}>
            {items.map((item) => {
              const isDropped = item.index < droppedCount;
              const message = isDropped ? undefined : messages[item.index - droppedCount];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 right-0 px-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {isDropped || (!message && loadingTop) ? (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      {t('chat.loadingHistory')}
                    </div>
                  ) : message ? (
                    <MessageItem message={message} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!following && <ScrollBottomButton onClick={jumpToBottom} />}
      <StatusBanner />
      <PermissionCard />
      <QuestionCard />
    </div>
  );
}
