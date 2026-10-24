# 兰台本末 · paint1 独立试验

版本 **1.0.0-test.20261024.paint1**，基于已发布24.5的完整安装字节，独立分支试验，不改main。

唯一行为变量是停用独立装饰paint委托：factory保留sync/dispose契约但无副作用，不创建frame／观察器／监听或delegated marker，由原业务root/header绘制原主题照片与背景。没有KTM局部适配，没有改业务owner、样式、圆角、overflow、滤镜或isolation。

这是一次尝试，未确认缺绘根因。已核实际memory-host完整跨区／关闭重开及headless Chrome春日原主题paint、标题和X；手机是否改善未知，不宣称修复。更新此分支后请整页刷新，避免热替换残留旧marker。

安装树308文件，BUILD-HASHES仅列安装path/bytes/SHA256。原字体与许可信息保留，无调试UI／额外TXT；不调用真实API。
