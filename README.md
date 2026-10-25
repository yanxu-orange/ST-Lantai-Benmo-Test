# 兰台本末 · 1.0.0-test.20261025.diag4

原 .4 基础上的独立诊断分支。本轮只对照业务面板外层裁剪，不宣称修复闪烁。

## 使用

现有 `codex/floating-diagnostic-20261025` 分支更新并刷新，确认 diag4，无需重复安装。

1. 设置 → 关于兰台 → 记录界面诊断。
2. 选“原裁剪（0 px）”，按相同路线切区并点“闪了／没闪”。
3. 选“取消外层裁剪（0 px）”，重复路线；再回“原裁剪（0 px）”重复。
4. 最后“停止并导出”，保存一个 JSON。✓表示当前选择。

两组固定顶部、高度减0 CSS px，宿主+18不动。不再提供1px尺寸按钮。取消组仅业务面板.lantai外层overflow改为visible!important；包含时间/工坊/本末已知mount下的对应外层，不扩大至任意嵌套.lantai。正文滚动和背景装饰裁剪均不修改。

默认不启用；停止、关闭、后台、切聊恢复原属性、移除临时样式。标记窗口保留可用前30秒＋后2秒，可连续重叠标记；32次或8 MiB估算档案容量上限停录提示导出。提前停止的后窗可能不完整。重新记录替换旧记录，刷新清空内存。

## 记录与验证

schema lantai-ui-transition-v5：每行与标记保存clipMode、shrinkCssPx和conditionEpoch，跨条件或旧条件事件淘汰后仍可辨认。两组同样低频读取精确矩形、client/scroll尺寸、视口，以及surface/main/decoration/page的白名单overflowX/Y；不会逐帧读布局。取消组clipVerification.surfaceMatches=false/null说明未确认实际生效。原裁剪组rule=no-override，记录真实样式而不假定hidden，匹配值不适用。还需比较几何、正文滚动与装饰状态。

不读取正文、标题、输入、HTML、URL或身份，不自动上传。DOM/rAF不证明像素已经绘出；工具开销和焦点影响仍需手机实测。

172项相关测试、594文件语法检查、静态依赖检查、离线构建、官方隔离打包通过；模拟宿主覆盖设置/时间/工坊/本末实际挂载父链，未做真实浏览器CSS或手机验收，未跑完整verify。源码提交 `d7c09d91862649bfba7d9b8b669002724262646e`。309安装文件SHA256见BUILD-HASHES.json。原.4回退参考 `codex/rollback-20261024-4`。
