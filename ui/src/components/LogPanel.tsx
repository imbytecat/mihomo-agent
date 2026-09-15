import { useEffect, useRef, useState } from 'react';
import type { GatewayModel } from '../use-gateway';
import { Button, Hint } from './ui';

export function LogPanel({ model }: { model: GatewayModel }) {
  const [live, setLive] = useState(true);
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState('');
  const output = useRef<HTMLPreElement>(null);
  const refresh = useRef(model.refreshDetail);
  refresh.current = model.refreshDetail;
  const source = model.detailTitle;
  useEffect(() => {
    setError('');
    setFollowing(true);
  }, [source]);
  useEffect(() => {
    if (!model.detailOpen || !live || !following || !['任务详情', '运行日志'].includes(source)) return;
    let stopped = false, pending = false;
    const timer = setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      void refresh.current().then(() => { if (!stopped) setError(''); })
        .catch((error) => { if (!stopped) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { pending = false; });
    }, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [model.detailOpen, live, following, source]);
  useEffect(() => {
    if (following && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [model.detail, model.detailOpen, following]);
  return (
    <div data-log-panel className="ufi:mt-4 ufi:rounded-2xl ufi:bg-[var(--mh-group)]">
      <div className="ufi:p-4">
        <div className="ufi:mb-3 ufi:flex ufi:flex-wrap ufi:items-center ufi:gap-2">
          <Button disabled={!model.task} onClick={() => void model.showTask()}>当前任务</Button>
          <Button disabled={!model.device?.agent} onClick={() => void model.showRuntimeLogs()}>运行日志</Button>
          <Button aria-pressed={live} onClick={() => setLive(!live)}>{live ? '暂停刷新' : '继续刷新'}</Button>
          {!following && <Button onClick={() => setFollowing(true)}>跟随最新</Button>}
          {model.task?.cancellable && <Button disabled={model.cancelling || model.task.cancelRequested} onClick={() => void model.cancelTask()}>取消当前任务</Button>}
          <Button aria-label="关闭详情" onClick={() => model.setDetailOpen(false)}>返回</Button>
        </div>
        <p data-log-source className="ufi:mb-2 ufi:mt-0 ufi:text-xs ufi:opacity-65">{source}</p>
        <pre ref={output} data-output tabIndex={0} aria-label={source}
          className="ufi:m-0 ufi:max-h-80 ufi:overflow-auto ufi:rounded-xl ufi:bg-black/25 ufi:p-3 ufi:whitespace-pre-wrap ufi:wrap-break-word ufi:select-text ufi:font-mono ufi:text-xs ufi:leading-relaxed"
          onScroll={(event) => { const node = event.currentTarget; setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 24); }}>
          {model.detail || '暂无记录，可选择当前任务或运行日志。'}
        </pre>
        <Hint error>{error && `日志刷新失败：${error}`}</Hint>
      </div>
    </div>
  );
}
