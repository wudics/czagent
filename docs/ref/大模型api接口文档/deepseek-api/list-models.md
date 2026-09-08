# 获取模型列表 & 查询余额

> 接口文档来源：
> - https://api-docs.deepseek.com/zh-cn/api/list-models
> - https://api-docs.deepseek.com/zh-cn/api/get-user-balance

---

## 一、获取模型列表

### 接口信息

- **方法**: GET
- **路径**: `/models`
- **认证**: `Authorization: Bearer ${DEEPSEEK_API_KEY}`

### 概述

列出可用的模型列表，并提供相关模型的基本信息。

### 响应格式（200 OK）

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "owned_by": "deepseek"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `object` | 恒为 `list` |
| `data[].id` | 模型标识符 |
| `data[].object` | 恒为 `model` |
| `data[].owned_by` | 拥有该模型的组织 |

### 调用示例

```bash
curl https://api.deepseek.com/models \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}"
```

```python
from openai import OpenAI

client = OpenAI(api_key="YOUR_KEY", base_url="https://api.deepseek.com")
models = client.models.list()
for m in models.data:
    print(m.id)
```

---

## 二、查询余额

### 接口信息

- **方法**: GET
- **路径**: `/user/balance`
- **认证**: `Authorization: Bearer ${DEEPSEEK_API_KEY}`

### 概述

查询账号余额。

### 响应格式（200 OK）

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `is_available` | 当前账户是否有余额可供 API 调用 |
| `balance_infos[].currency` | 货币类型：`CNY`（人民币）或 `USD`（美元） |
| `balance_infos[].total_balance` | 总的可用余额（含赠金和充值余额） |
| `balance_infos[].granted_balance` | 未过期的赠金余额 |
| `balance_infos[].topped_up_balance` | 充值余额 |

### 调用示例

```bash
curl https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}"
```

```python
from openai import OpenAI

client = OpenAI(api_key="YOUR_KEY", base_url="https://api.deepseek.com")
balance = client.balance.retrieve()
print(balance)
```
