// UFI-TOOLS 4.1.3, http-server-version. Named exports allow unused capabilities
// to be removed from a plugin bundle. Responses retain their wire semantics.
// Pure initializers include their schema construction, so unused definitions
// disappear without leaving argument evaluation in the consuming bundle.
import { z } from 'zod';
import { get, post } from './endpoint';
import * as s from './schemas';

export const baseDeviceInfo = /* @__PURE__ */ (() => get('baseDeviceInfo', s.none, s.deviceInfo))();
export const connInfo = /* @__PURE__ */ (() => get('connInfo', s.none, z.object({ result: z.literal('success'), data: z.object({ tcp: s.text, tcp_active: s.text, tcp_other: s.text, tcp6: s.text, udp: s.text, udp6: s.text, unix: s.text }) })))();
export const cellularUsage = /* @__PURE__ */ (() => get('cellularUsage', z.object({ startTime: z.int().nonnegative(), endTime: z.int().nonnegative(), method: z.enum(['date-range', 'mills-range']).optional() }).strict().refine((value) => value.endTime >= value.startTime, 'endTime must not precede startTime'), z.object({ result: z.literal('success'), usage: z.union([s.text, z.array(z.object({ date: s.text, usage: s.text }))]) })))();
export const acceptTerms = /* @__PURE__ */ (() => post('accept_terms', s.none, s.success))();
export const setNickname = /* @__PURE__ */ (() => post('set_nickname', z.object({ nickname: s.text }).strict(), s.success))();
export const versionInfo = /* @__PURE__ */ (() => get('version_info', s.none, z.object({ app_ver: s.text, app_ver_code: s.text, model: s.text, nickname: s.text, accept_terms: z.boolean() }), { authenticated: false }))();
export const deviceId = /* @__PURE__ */ (() => get('device_id', s.none, z.object({ device_id: s.text })))();
export const selinux = /* @__PURE__ */ (() => get('SELinux', s.none, z.object({ selinux: s.text }), { authenticated: false }))();
export const needToken = /* @__PURE__ */ (() => get('need_token', s.none, z.object({ need_token: z.boolean() }), { authenticated: false }))();
export const usbStatus = /* @__PURE__ */ (() => get('usb_status', s.none, z.object({ maxSpeed: z.number(), details: z.json() })))();
export const getVolte = /* @__PURE__ */ (() => get('volte_status', s.slot, s.enabled))();
export const setVolte = /* @__PURE__ */ (() => post('volte_status', s.volte, s.success))();
export const getVonr = /* @__PURE__ */ (() => get('vonr_status', s.slot, s.enabled))();
export const setVonr = /* @__PURE__ */ (() => post('vonr_status', s.volte, s.success))();
export const getCookie = /* @__PURE__ */ (() => get('get_cookie', s.none, z.object({ cookie: s.text })))();
export const setCookie = /* @__PURE__ */ (() => post('set_cookie', z.object({ cookie: s.text }).strict(), s.success))();

export const isWeakToken = /* @__PURE__ */ (() => get('is_weak_token', s.none, z.object({ is_weak_token: z.boolean() })))();
export const setToken = /* @__PURE__ */ (() => post('set_token', z.object({ token: s.text.min(8).max(128).regex(/^(?=.*[a-zA-Z])(?=.*\d).+$/) }).strict(), s.success))();
export const getResourceServer = /* @__PURE__ */ (() => get('get_res_server', s.none, z.object({ res_server: s.text })))();
export const setResourceServer = /* @__PURE__ */ (() => post('set_res_server', z.object({ res_server: s.httpURL }).strict(), s.success))();
export const getLogStatus = /* @__PURE__ */ (() => get('get_log_status', s.none, z.object({ debug_log_enabled: s.stringBoolean })))();
export const setLogStatus = /* @__PURE__ */ (() => post('set_log_status', z.object({ debug_log_enabled: z.boolean() }).strict(), s.success))();
export const setWakelock = /* @__PURE__ */ (() => post('set_wakelock_status', z.object({ wakelock_enabled: z.boolean() }).strict(), s.success))();
export const getDataLimit = /* @__PURE__ */ (() => get('get_data_limit', s.none, s.dataLimit))();
export const setDataLimit = /* @__PURE__ */ (() => post('set_data_limit', s.dataLimitInput, s.success))();

export const setOfficialPassword = /* @__PURE__ */ (() => post('update_admin_pwd', z.object({ password: s.text }).strict(), s.success))();
export const getOfficialPassword = /* @__PURE__ */ (() => get('get_official_web_password', s.none, z.object({ pwd: s.text })))();
export const getAdbWifi = /* @__PURE__ */ (() => get('adb_wifi_setting', s.none, s.enabled))();
export const setAdbWifi = /* @__PURE__ */ (() => post('adb_wifi_setting', z.object({ enabled: z.boolean(), password: s.text.optional() }).strict(), z.object({ result: z.literal('success'), enabled: s.stringBoolean })))();
export const adbAlive = /* @__PURE__ */ (() => get('adb_alive', s.none, z.object({ result: s.stringBoolean })))();

export const atCommand = /* @__PURE__ */ (() => get('AT', z.object({ command: s.nonempty.regex(/^AT/i), slot: z.union([z.literal(0), z.literal(1)]).optional() }).strict(), s.result))();
export const supportedNrBands = /* @__PURE__ */ (() => get('getSupportNrBandList', s.slot, z.object({ slot: z.number(), band_list: z.array(z.number()) })))();

export const setAdvancedMode = /* @__PURE__ */ (() => get('smbPath', s.querySwitch, s.result))();
export const disableFota = /* @__PURE__ */ (() => get('disable_fota', s.none, s.result))();
export const ttydStatus = /* @__PURE__ */ (() => get('hasTTYD', z.object({ port: s.port }).strict(), z.object({ code: s.text, ip: s.text })))();
export const oneClickShell = /* @__PURE__ */ (() => get('one_click_shell', s.none, s.result, { timeout: 120_000 }))();
export const userShell = /* @__PURE__ */ (() => post('user_shell', z.object({ command: s.nonempty }).strict(), z.object({ result: z.object({ done: z.boolean(), content: s.text }) }), { timeout: 310_000 }))();
// The HTTP route rejects a null socket result and returns a string on success.
export const rootShell = /* @__PURE__ */ (() => post('root_shell', z.object({ command: s.nonempty, timeout: z.int().min(1).max(100_000).optional() }).strict(), z.object({ result: s.text }), { timeout: 110_000 }))();

export const checkAppUpdate = /* @__PURE__ */ (() => get('check_update', s.none, z.object({ base_uri: s.text, alist_res: s.alist, changelog: s.text })))();
export const downloadApk = /* @__PURE__ */ (() => post('download_apk', z.object({ apk_url: s.httpURL }).strict(), z.object({ result: z.literal('download_started') })))();
export const downloadApkStatus = /* @__PURE__ */ (() => get('download_apk_status', s.none, z.object({ status: z.enum(['idle', 'downloading', 'done', 'error']), percent: z.number(), error: s.text })))();
export const installApk = /* @__PURE__ */ (() => post('install_apk', s.none, s.success, { timeout: 120_000 }))();

export const getCustomHead = /* @__PURE__ */ (() => get('get_custom_head', s.none, z.object({ text: s.text }), { authenticated: false }))();
export const setCustomHead = /* @__PURE__ */ (() => post('set_custom_head', z.object({ text: s.text }).strict(), s.success, { bodyLimit: 5 * 1024 * 1024 }))();
export const pluginsStore = /* @__PURE__ */ (() => get('plugins_store', s.none, z.object({ download_url: s.text, res: s.alist })))();

export const smsForwardMethod = /* @__PURE__ */ (() => get('sms_forward_method', s.none, z.object({ sms_forward_method: z.enum(['', 'SMTP', 'CURL', 'DINGTALK']) })))();
export const getSmsMail = /* @__PURE__ */ (() => get('sms_forward_mail', s.none, s.smtp))();
export const setSmsMail = /* @__PURE__ */ (() => post('sms_forward_mail', s.smtpInput, s.result))();
export const getSmsCurl = /* @__PURE__ */ (() => get('sms_forward_curl', s.none, z.object({ curl_text: s.text })))();
export const setSmsCurl = /* @__PURE__ */ (() => post('sms_forward_curl', z.object({ curl_text: s.text.refine((value) => ['{{sms-body}}', '{{sms-time}}', '{{sms-from}}'].every((key) => value.includes(key)), 'Missing SMS template placeholders') }).strict(), s.result))();
export const getSmsDingtalk = /* @__PURE__ */ (() => get('sms_forward_dingtalk', s.none, s.dingtalk))();
export const setSmsDingtalk = /* @__PURE__ */ (() => post('sms_forward_dingtalk', s.dingtalkInput, s.result))();
export const getSmsForwardEnabled = /* @__PURE__ */ (() => get('sms_forward_enabled', s.none, s.enabledString))();
export const setSmsForwardEnabled = /* @__PURE__ */ (() => post('sms_forward_enabled', s.querySwitch, s.success, { encoding: 'query' }))();
export const getPowerForwardEnabled = /* @__PURE__ */ (() => get('power_status_forward_enabled', s.none, s.enabledString))();
export const setPowerForwardEnabled = /* @__PURE__ */ (() => post('power_status_forward_enabled', s.querySwitch, s.success, { encoding: 'query' }))();
export const getSmsBlacklist = /* @__PURE__ */ (() => get('sms_forward_blacklist', s.none, s.blacklist))();
export const setSmsBlacklist = /* @__PURE__ */ (() => post('sms_forward_blacklist', s.blacklist, s.success))();
export const forwardMessage = /* @__PURE__ */ (() => post('do_forward_msg', z.object({ address: s.text, body: s.text, is_sms: z.boolean().optional(), timestamp: z.int().optional() }).strict(), s.result))();

export const addTask = /* @__PURE__ */ (() => post('add_task', s.taskInput, s.success))();
export const removeTask = /* @__PURE__ */ (() => post('remove_task', z.object({ id: s.nonempty }).strict(), z.object({ result: z.literal('removed') })))();
export const clearTasks = /* @__PURE__ */ (() => post('clear_task', s.none, s.success))();
export const listTasks = /* @__PURE__ */ (() => get('list_tasks', s.none, z.object({ tasks: z.array(s.taskInfo) })))();
export const getTask = /* @__PURE__ */ (() => get('get_task', z.object({ id: s.nonempty }).strict(), s.taskInfo))();

export const uploadFile = /* @__PURE__ */ (() => post('upload_img', s.uploadInput, z.object({ url: s.text.regex(/^\/uploads\/[^/]+$/) }), { encoding: 'multipart' }))();
export const deleteFile = /* @__PURE__ */ (() => post('delete_img', z.object({ file_name: s.fileName }).strict(), s.success))();
export const deleteAllUploads = /* @__PURE__ */ (() => post('delete_all_uploads_data', s.none, z.object({ result: z.literal('success'), deleted_list: z.record(s.text, z.boolean()) })))();
export const getTheme = /* @__PURE__ */ (() => get('get_theme', s.none, s.theme, { authenticated: false }))();
export const setTheme = /* @__PURE__ */ (() => post('set_theme', s.theme.partial().strict(), s.success))();
export const speedtest = /* @__PURE__ */ (() => get('speedtest', z.object({ ckSize: z.int().min(1).max(1024).optional(), cors: s.text.optional() }).strict().default({}), s.raw, { raw: true }))();
