import { z } from 'zod';

export const none = /* @__PURE__ */ (() => z.undefined())();
export const text = /* @__PURE__ */ (() => z.string())();
export const nonempty = /* @__PURE__ */ (() => text.trim().min(1))();
export const binarySwitch = /* @__PURE__ */ (() => z.enum(['0', '1']))();
export const stringBoolean = /* @__PURE__ */ (() => z.enum(['true', 'false']))();
export const result = /* @__PURE__ */ (() => z.object({ result: text }))();
export const success = /* @__PURE__ */ (() => z.object({ result: z.literal('success') }))();
export const strings = /* @__PURE__ */ (() => z.record(text, text))();
export const scalar = /* @__PURE__ */ (() => z.union([text, z.number().finite(), z.boolean()]))();
export const port = /* @__PURE__ */ (() => z.int().min(1).max(65535))();
export const slot = /* @__PURE__ */ (() => z.object({ slot: z.union([z.literal(0), z.literal(1)]).optional() }).strict().default({}))();
export const volte = /* @__PURE__ */ (() => z.object({ enabled: binarySwitch, slot: binarySwitch.optional() }).strict())();
export const httpURL = /* @__PURE__ */ (() => z.url({ protocol: /^https?$/ }))();
export const enabled = /* @__PURE__ */ (() => z.object({ enabled: z.boolean() }))();
export const enabledString = /* @__PURE__ */ (() => z.object({ enabled: binarySwitch }))();
export const querySwitch = /* @__PURE__ */ (() => z.object({ enable: binarySwitch }).strict())();
export const fileName = /* @__PURE__ */ (() => nonempty.refine((value) => !/[\\/\0]/.test(value) && !value.includes('..'), 'A single file name is required'))();
export const uploadInput = /* @__PURE__ */ (() => z.object({ file: z.instanceof(Blob), filename: fileName.optional() }).strict())();
export const raw = /* @__PURE__ */ (() => z.custom<Response>((value) => Object.prototype.toString.call(value) === '[object Response]'))();

export const deviceInfo = /* @__PURE__ */ (() => z.object({
  app_ver: text.nullable(), app_ver_code: text.nullable(), model: text.nullable(), battery: text.nullable(),
  daily_data: z.number().nullable(), monthly_data: z.number().nullable(),
  internal_available_storage: z.number().nullable(), internal_used_storage: z.number().nullable(), internal_total_storage: z.number().nullable(),
  external_total_storage: z.number().nullable(), external_used_storage: z.number().nullable(), external_available_storage: z.number().nullable(),
  cpu_temp_list: z.json(), cpu_temp: z.number().nullable(), client_ip: text.nullable(), cpu_usage: z.number().nullable(), mem_usage: z.number().nullable(),
  cpuFreqInfo: z.json(), cpuUsageInfo: z.json(), memInfo: z.json(),
  current_now: z.number().nullable(), voltage_now: z.number().nullable(), is_reached_data_flow_limit: z.boolean().nullable(),
}).passthrough())();

export const dataLimitInput = /* @__PURE__ */ (() => z.object({
  data_flow_limit_enabled: z.union([binarySwitch, z.boolean()]).optional(),
  data_limit_status_forward_enabled: z.union([binarySwitch, z.boolean()]).optional(),
  data_flow_max_limit: z.number().finite().optional(),
  data_flow_check_daily_or_monthly: z.enum(['daily', 'monthly']).optional(),
  data_check_reference: z.enum(['android', 'ufi', 'default']).optional(),
}).strict())();
export const dataLimit = /* @__PURE__ */ (() => z.object({
  data_flow_limit_enabled: binarySwitch, data_limit_status_forward_enabled: binarySwitch,
  data_flow_max_limit: z.number(), data_flow_check_daily_or_monthly: text, data_check_reference: text,
}))();

export const smtp = /* @__PURE__ */ (() => z.object({
  smtp_host: text, smtp_port: text, smtp_to: text, smtp_username: text, smtp_password: text, forward_dev_info: binarySwitch,
}))();
export const smtpInput = /* @__PURE__ */ (() => smtp.extend({
  smtp_host: nonempty, smtp_to: nonempty, smtp_username: nonempty, smtp_password: nonempty,
  smtp_port: text.regex(/^\d+$/).refine((value) => Number(value) > 0 && Number(value) <= 65535).optional(),
  forward_dev_info: binarySwitch.optional(),
}).strict())();
export const dingtalk = /* @__PURE__ */ (() => z.object({ webhook_url: text, secret: text, forward_dev_info: binarySwitch }))();
export const dingtalkInput = /* @__PURE__ */ (() => dingtalk.extend({ webhook_url: httpURL, secret: text.optional(), forward_dev_info: binarySwitch.optional() }).strict())();
export const blacklist = /* @__PURE__ */ (() => z.object({ phone: text.regex(/^[0-9\n]*$/), keywords: text }).strict())();

export const taskInfo = /* @__PURE__ */ (() => z.object({
  key: z.number(), id: text, time: text, repeatDaily: z.boolean(),
  actionMap: strings.optional(), lastRunTimestamp: z.number().nullable().optional(), hasTriggered: z.boolean().optional(),
}))();
export const taskInput = /* @__PURE__ */ (() => z.object({
  id: nonempty, time: text.regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  repeatDaily: z.boolean().optional(), action: strings,
}).strict())();

export const theme = /* @__PURE__ */ (() => z.object({
  backgroundEnabled: text, backgroundUrl: text, textColor: text, textColorPer: text,
  themeColor: text, colorPer: text, saturationPer: text, brightPer: text,
  opacityPer: text, blurSwitch: text, overlaySwitch: text,
}))();

// Alist and firmware responses contain provider-specific fields. Keep those
// fields unknown instead of presenting a partial sample as an exhaustive type.
export const alist = /* @__PURE__ */ (() => z.object({
  code: z.number(), message: text,
  data: z.object({ content: z.array(z.object({ name: text, modified: text.optional(), size: z.number().optional() }).passthrough()).optional() }).passthrough().nullable().optional(),
}).passthrough())();
