import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Progress } from '@base-ui/react/progress';
import { describeTask, phases, transferText } from '../gateway';
import type { DeviceJob } from '../state';
import type { GatewayModel } from '../use-gateway';
import { Button } from './ui';

export function TaskNotice({
  model,
  job,
  installation = false,
}: {
  model: GatewayModel;
  job: DeviceJob;
  installation?: boolean;
}) {
  const active = ['queued', 'running'].includes(job.state);
  const failed = ['failed', 'interrupted'].includes(job.state);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const downloading = active && ['download', 'subscription'].includes(job.phase);
  const cancellableAction = ['bootstrap', 'download', 'download-dashboard', 'self-update', 'update'].includes(job.action);
  return (
    <div className="ufi:p-3">
      <Button
        full
        data-task={!installation || undefined}
        data-install-task={installation || undefined}
        variant={failed ? 'danger' : 'default'}
        onClick={() => void model.showTask()}
      >
        {active && (
          <LoaderCircle
            size={14}
            className="ufi:animate-spin ufi:motion-reduce:animate-none"
            aria-hidden
          />
        )}
        {active
          ? job.cancelRequested ? '正在取消并清理…' : phases[job.phase] || '处理中'
          : failed
            ? describeTask(job).split('\n')[0] + '失败 · 查看详情'
            : job.state === 'cancelled'
              ? '任务已取消 · 查看详情'
            : '最近安装任务 · 查看详情'}
      </Button>
      {downloading && (
        <Progress.Root
          value={job.total ? Math.min(100, job.downloaded / job.total * 100) : null}
          aria-label="下载进度"
          aria-valuetext={transferText(job, now)}
          className="ufi:mt-3"
        >
          <Progress.Track className="ufi:h-2 ufi:overflow-hidden ufi:rounded-full ufi:bg-white/10">
            <Progress.Indicator className="ufi:h-full ufi:rounded-full ufi:bg-[#0a84ff] ufi:data-[indeterminate]:w-1/3 ufi:data-[indeterminate]:animate-pulse" />
          </Progress.Track>
          <p data-transfer className="ufi:mb-0 ufi:mt-2 ufi:break-words ufi:text-xs ufi:opacity-70">
            {transferText(job, now)}
          </p>
        </Progress.Root>
      )}
      {active && cancellableAction && (
        <Button
          data-cancel-task
          className="ufi:mt-3"
          disabled={!job.cancellable || job.cancelRequested || model.cancelling}
          title={!job.cancellable ? '正在应用更改，此阶段不可取消' : undefined}
          onClick={() => void model.cancelTask()}
        >
          {job.cancelRequested || model.cancelling ? '正在取消…' : '取消任务'}
        </Button>
      )}
    </div>
  );
}
