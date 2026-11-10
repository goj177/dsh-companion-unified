# 来源与许可证

原生统一服务使用根目录 MIT 许可证。安装包不包含旧插件运行入口或旧资料读取器。QQ 的纯协议与消息解析辅助保留 BSD-3-Clause 许可，因此整体标注 `MIT AND BSD-3-Clause`。

原插件的功能经验、迁移规则及表达原则参考以下来源；完整原许可与说明分别保存在 `legal/`：

| 来源 | 基线 | 许可 |
|---|---|---|
| Phant0Meow / dsh-meow-memory | 0.31.1 | MIT |
| Yuuyuko-uu / dsh-feiyu-mood | 0.5.0 | MIT |
| Nekomeow114 / dsh-tieba-scroll | 1.28.2 | MIT |
| mario841859784 / dsh-onebot | 0.9.6 | BSD-3-Clause |
| liuwenji007 / dsh-humanizer | a1f221630403496c00bbbbaa5814dd1b48c78438 | MIT |
| ALTERSSSS / dsh-bili-whale | 0.4.7 | MIT |
| y258dd / dsh-hormone | 0.4.0 / 736c74b6b5cb685bce2a9891dae24451b38ab0ca | MIT |

`native/protocol/` 的 chat、cq、connection、errors 辅助来自 OneBot 上述版本。其余服务重新围绕同一原生数据库和权限来源组织。自然表达层只参考 humanizer 的正向表达原则与分类，不执行旧分类器，不在原文上批量替换句子。

Node/npm 依赖各自保留许可证。代码包不包含 Node/Python 可执行文件、FFmpeg、NapCat、ASR 权重或用户资料。

`native/hormone.mjs` 的四状态与耦合机制改编自 [y258dd/dsh-hormone](https://github.com/y258dd/dsh-hormone/tree/736c74b6b5cb685bce2a9891dae24451b38ab0ca)。保留其MIT版权及许可，并增加原生存储、并发会话隔离、可信跨平台来源、统一心情表达和中断结算；不加载独立激素插件入口。
