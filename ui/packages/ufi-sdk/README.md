# @imbytecat/ufi-sdk

本仓库自用的 TypeScript SDK，面向 UFI-TOOLS 4.1.3 的 `http-server-version` 实现。覆盖 **70 个固定 HTTP 接口、4 类通配入口**；不依赖 React、mihomoctl、DOM 页面或 Go 程序。`./host` 入口专门用于 UFI 页面插件。

通过 Bun workspace 使用，源码由 Bun 或 Vite 消费；当前不发布 npm 包。HTTP 使用 ky，输入和响应校验使用 Zod，签名使用 Noble Hashes。接口是独立导出，调用方未导入的设备能力可以被 tree-shaking 移除。

## 独立使用

```ts
import {
  UfiClient, authorizationFromPassword, versionInfo, rootShell, uploadFile,
} from '@imbytecat/ufi-sdk';

const ufi = new UfiClient({
  origin: 'http://192.168.0.1:2333',
  authorization: authorizationFromPassword(password),
  fetch: globalThis.fetch.bind(globalThis),
});

const version = await ufi.request(versionInfo);
const output = await ufi.request(rootShell, {
  command: 'printf hello', timeout: 5000,
}); // { result: string }，不包含命令退出码
const uploaded = await ufi.request(uploadFile, {
  file: new File(['example'], 'example.txt'),
}); // { url: '/uploads/<uuid>.txt' }
```

`origin` 必须是没有路径、query 或凭据的 HTTP(S) origin。`authorization` 是登录口令的 SHA-256 小写十六进制摘要；也可传返回当前摘要的函数，SDK 每次请求重新读取。无口令认证的设备可省略此项。`setToken` 的参数则是新明文口令，SDK 不会自动改写调用方持有的授权值。

`request(endpoint, input, { signal, timeout })` 根据接口推断输入与返回类型，并进行运行时校验。无参数接口省略 `input`；要单独传 options 时使用 `undefined`。默认 30 秒，Shell 和安装类接口有更长的默认值；`timeout: false` 关闭该超时。取消客户端请求不保证服务器已经停止正在执行的操作。

Root Shell 默认等待 110 秒，User Shell 默认等待 310 秒，分别留出后端 100／300 秒执行限制之外的响应时间。昵称截断和负时间戳等规则由设备处理：长昵称会被截为 255 字符，消息转发的负时间戳表示设备当前时间。

## UFI 页面插件

```ts
import { rootShell } from '@imbytecat/ufi-sdk';
import { createUfiHostClient, hostFetch } from '@imbytecat/ufi-sdk/host';

const ufi = createUfiHostClient();
await ufi.request(rootShell, { command: 'id', timeout: 5000 });

// 外部公开请求使用未被 UFI 包装的 fetch，明确省略浏览器凭据。
await hostFetch('https://api.github.com/repos/imbytecat/mihomoctl/releases/latest', {
  credentials: 'omit',
});
```

宿主适配读取 `KANO_baseURL`、`common_headers.authorization` 和裸全局词法绑定 `originFetch`。当前官方构建保留这些名称；`originFetch` 不属于已承诺稳定的文档 SDK API，缺失时明确报错。SDK 自行添加认证和签名，不调用会假设字符串参数的 `window.fetch` 包装，也不修改页面全局函数。

## 接口分组

直接导入对应定义并调用 `ufi.request(定义, 参数)`；请求字段沿用 UFI 的实际字段名。

| 能力 | 导出 |
| --- | --- |
| 设备信息、流量、SIM 功能 | `baseDeviceInfo`、`connInfo`、`cellularUsage`、`versionInfo`、`deviceId`、`selinux`、`needToken`、`usbStatus`、`getVolte` / `setVolte`、`getVonr` / `setVonr` |
| 条款、别名、会话 | `acceptTerms`、`setNickname`、`getCookie`、`setCookie` |
| 配置 | `isWeakToken`、`setToken`、`getResourceServer` / `setResourceServer`、`getLogStatus` / `setLogStatus`、`setWakelock`、`getDataLimit` / `setDataLimit` |
| ADB | `getOfficialPassword`、`setOfficialPassword`、`getAdbWifi`、`setAdbWifi`、`adbAlive` |
| AT | `atCommand`、`supportedNrBands` |
| 高级功能 | `setAdvancedMode`、`disableFota`、`ttydStatus`、`oneClickShell`、`rootShell`、`userShell` |
| 应用更新 | `checkAppUpdate`、`downloadApk`、`downloadApkStatus`、`installApk` |
| 插件 | `getCustomHead`、`setCustomHead`、`pluginsStore` |
| 消息转发 | `smsForwardMethod`、`getSmsMail` / `setSmsMail`、`getSmsCurl` / `setSmsCurl`、`getSmsDingtalk` / `setSmsDingtalk`、`getSmsForwardEnabled` / `setSmsForwardEnabled`、`getPowerForwardEnabled` / `setPowerForwardEnabled`、`getSmsBlacklist` / `setSmsBlacklist`、`forwardMessage` |
| 定时任务 | `addTask`、`removeTask`、`clearTasks`、`listTasks`、`getTask` |
| 主题与文件 | `getTheme`、`setTheme`、`uploadFile`、`deleteFile`、`deleteAllUploads` |
| 测速 | `speedtest`，返回未消费的 `Response` |

具体参数和响应定义在 [endpoints.ts](src/endpoints.ts) 与 [schemas.ts](src/schemas.ts)。`Input<typeof rootShell>`、`Output<typeof rootShell>` 可用于业务侧类型声明。

## 通配能力与固件接口

以下方法都返回 `Response`，由调用方决定读取 JSON、文本或流：

```ts
await ufi.readUpload('uuid.txt');           // GET /api/uploads/uuid.txt
await ufi.readAsset('lang/zh.json');        // GET /lang/zh.json；空字符串为首页
await ufi.forward('https://example.com/data', { method: 'GET' });
await ufi.goform('goform_get_cmd_process', {
  query: { isTest: false, cmd: 'Language,cr_version', multi_data: 1 },
  cookie: sessionCookie,
});
await ufi.goform('goform_set_cmd_process', {
  method: 'POST', cookie: sessionCookie,
  form: { goformId: operation, isTest: false, AD: ad, ...parameters },
});
```

`forward` 对应 UFI 自身的通用 HTTP 转发入口；支持原始响应及请求体，按后端限制仅 POST / PUT / PATCH 转发 body。`goform` 仅 POST / PUT 支持表单体；固件的 `cmd`、`goformId` 和响应字段随设备变化，SDK 保留其透传语义，不把某型号的字段列表冒充完整固件协议。`goformLoginPassword` 与 `goformAD` 计算官方前端使用的双重大写 SHA-256 挑战；登录、Cookie 存取、退出均由调用方明确执行。

## 错误与副作用

- 所有请求 `retry: 0`。部分 GET（AT、高级模式、一键脚本等）会修改设备，不能按 HTTP 方法推断可安全重试。SDK 构造和导入不会触发设备操作，也不会自动轮询或转发消息。
- HTTP 错误沿用 ky 的 `HTTPError`，包含状态和响应；网络与超时错误分别使用 `NetworkError`、`TimeoutError`。HTTP 200 的单独 `{error}` 对象抛出 `UfiDeviceError`；响应结构不符抛出 `UfiResponseError`；输入不符由 Zod 拒绝。
- 业务状态按原始响应返回：Root Shell 没有退出码，`userShell.result.done` 可为 false，OTA 可返回 `status: 'error'`，AT 输出可含 `ERROR`。SDK 不把这些结果自动改成成功。mihomoctl 自己检查命令退出标记和持久任务状态。
- SDK 不记录请求头、正文或响应。口令摘要仍是凭据；部分读取接口会返回明文密码。Root Shell 会被宿主记录；设置 SMTP、CURL 或钉钉会立即由设备发送测试消息。
- 请求固定在配置的 UFI origin，省略浏览器 Cookie，拒绝跟随重定向。公开端点不加设备认证头。普通签名覆盖 method / path / timestamp，不覆盖 query 和 body，服务端未校验时间窗口；它不构成请求防重放保证。

## 官方实现与文档差异

以当前 [Kotlin 路由](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/mainModule.kt) 为准：

- `root_shell` 实际是 `{result: string}`，不是 API 文档示例中的 `{done, content}`；`user_shell` 才返回该对象。
- `baseDeviceInfo` 的 CPU、内存详情直接嵌入 JSON，SDK 使用 JSON 值类型，不假设它们全是字符串。Alist 与固件的扩展字段保持未知类型。
- `one_click_shell`、`install_apk` 是一个最终 JSON 对象，不是 SSE 或 NDJSON。
- Any Proxy 源码会把所有 `kano-*` 去前缀转发，包括 `kano-t` / `kano-sign`。SDK 不能承诺转发后完全没有这些头；原始 `authorization` 由后端过滤。显式上游认证使用 `kano-Authorization`，不能覆盖 SDK 自己的 `authorization`。
- goform 源码有再次拼接 query 的行为；SDK 保证发给 UFI 的参数正确，不宣称固件收到的 query 字节保持不变。跨域浏览器访问还受宿主预检与 CORS 实现限制。

[API 文档](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/API_Doc.md) · [宿主请求实现](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js) · [混淆构建配置](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/build.js)

验证入口：仓库根目录执行 `mise exec -- just check` 与 `mise exec -- just test-ui`。测试只用模拟传输、固定签名向量和本地 CLI fixture，不调用用户设备。接口清单完整覆盖不等于全部硬件功能已实机验收。
