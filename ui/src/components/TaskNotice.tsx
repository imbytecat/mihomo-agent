import { LoaderCircle } from 'lucide-react';
import { describeTask, phases } from '../gateway';
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
          ? phases[job.phase] || '处理中'
          : failed
            ? describeTask(job).split('\n')[0] + '失败 · 查看详情'
            : '最近安装任务 · 查看详情'}
      </Button>
    </div>
  );
}
