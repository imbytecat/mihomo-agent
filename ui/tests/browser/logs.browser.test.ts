import { expect, test } from 'vitest';
import { app, evaluate, idle, open } from './app';

test('inline runtime logs refresh, pause and stop following while reading older lines', async () => {
  await open('ready');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await app.getByCSS('[data-log-panel]').getByRole('button', { name: '运行日志', exact: true }).click();
  await expect.element(app.getByCSS('[data-log-source]')).toHaveTextContent('运行日志');
  await evaluate('mockRuntimeLog = "fresh log line"');
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('fresh log line');
  await app.getByRole('button', { name: '暂停刷新', exact: true }).click();
  await evaluate('mockRuntimeLog = "next log line"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('fresh log line');
  await app.getByRole('button', { name: '继续刷新', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('next log line');
  await evaluate('mockRuntimeLog = Array.from({length:100}, (_,i)=>"line "+i).join("\\n")');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('line 99');
  await evaluate('const log = document.querySelector("[data-output]"); log.scrollTop=0; log.dispatchEvent(new Event("scroll"))');
  await expect.element(app.getByRole('button', { name: '跟随最新', exact: true })).toBeVisible();
  await evaluate('mockRuntimeLog = "latest line"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('line 0');
  await app.getByRole('button', { name: '跟随最新', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('latest line');
  await app.getByRole('tab', { name: '概览', exact: true }).click();
  await evaluate('mockRuntimeLog = "hidden tab update"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('latest line');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('hidden tab update');
});

test('startup failure automatically opens the inline reason and runtime evidence', async () => {
  await open('ready');
  await evaluate('mockTaskFailure = "代理启动失败\\ncore.log（本次启动）:\\nlisten tcp :1053: address already in use"');
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await idle();
  await expect.element(app.getByCSS('[data-log-panel]')).toBeVisible();
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('address already in use');
  await expect.element(app.getByCSS('[data-dialog=result]')).not.toBeInTheDocument();
});
