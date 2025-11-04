# 🤖 Zotero LLM Auto-Tagger  
### 自动从论文中提取结构化元数据 + 智能标签标准化 + 本地 PDF 内容解析

> 使用本脚本可自动为 Zotero 条目生成标准化标签与元数据，无需上传 PDF，最大化隐私与自动化。
> **本项目由作者引导Chat GPT-5生成**

---

## ✨ 功能特性
 
✅ **自动写回 Tags 与 Extra (YAML)**  
✅ **机构名智能处理**（中英文规则：MIT、CMU、清华大学等）  
✅ **复用已有标签体系， 自动扩展标签**  
- 扫描全库现有 `key:value` 标签  
- 按字段分组传入提示词  
- 模型自动对齐最常用且规范的标签形式  

✅ **扩展字段支持（≤3）**：如 dataset、sim2real、benchmark、hardware  

 

---

## 📌 支持提取的字段

| 字段 | 类型 | 示例 |
|--------|--------|--------|
| institution | string | MIT、清华大学、UC Berkeley |
| method_name | array | ["ASE", "AMP-like"] |
| research_content | array | ["teacher student", "GAN"] |
| research_type | string | algorithm、control、RL |
| robot_name | array | ["Unitree G1", "Atlas"] |
| robot_type | array | ["humanoid", "bipedal"] |
| task | array | ["locomotion", "loco-manipulation"] |
| extended_* | array (≤3 keys) | dataset / sim2real / benchmark |

---

## 🚀 使用方式

### 1. 安装 Zotero 插件

需预装插件：

| 插件 | 用途 |
|--------|--------|
| **Actions & Tags for Zotero** | 运行脚本，新增动作菜单 |

👉 插件地址：<https://github.com/windingwind/zotero-actions-tags>

### 2. 添加脚本

1. 打开：`Tools → Actions & Tags → Manage Scripts`
2. 新建脚本，将本项目主脚本粘入
3. **在文件顶部填入你的 API Key**

```js
const DEEPSEEK_API_KEY = "YOUR_KEY_HERE";
```
