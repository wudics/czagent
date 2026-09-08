# Audio 模块（语音合成 / 上传 / 转录）

> 接口文档来源：
> - https://api-docs.siliconflow.cn/docs/api/audio-speech-post
> - https://api-docs.siliconflow.cn/docs/api/uploads-audio-voice-post
> - https://api-docs.siliconflow.cn/docs/api/audio-voice-list-get
> - https://api-docs.siliconflow.cn/docs/api/audio-voice-deletions-post
> - https://api-docs.siliconflow.cn/docs/api/audio-transcriptions-post

---

## 一、Create a Speech（语音合成 TTS）

### 接口信息

- **方法**: POST
- **路径**: `/v1/audio/speech`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

根据输入文本生成音频，返回音频的二进制数据，需用户自行处理。

### 请求参数（Body）

**MOSS-TTSD-v0.5（对话语音合成）**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 固定为 `fnlp/MOSS-TTSD-v0.5` |
| `input` | string | ✅ | 对话文本，用说话人标签标注轮次：`[S1]` / `[S2]`。长度 [1, 128000] |
| `max_tokens` | integer | ❌ | 最大 token 数，输入 + 输出不超过 32k tokens |
| `references` | array | ❌ | 双音色脚本对话时传入两个音色（仅 moss 模型） |
| `voice` | string | ❌ | 音色，如 `fnlp/MOSS-TTSD-v0.5:alex`（不支持双音色） |
| `response_format` | string | ❌ | 输出格式：`mp3` / `opus` / `wav` / `pcm`，默认 `mp3` |
| `sample_rate` | number | ❌ | 采样率，默认 32000 |
| `stream` | boolean | ❌ | 是否流式输出 |
| `speed` | number | ❌ | 语速 [0.25, 4.0]，默认 1 |
| `gain` | number | ❌ | 增益，范围 [-10, 10] |

**CosyVoice2-0.5B**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 固定为 `FunAudioLLM/CosyVoice2-0.5B` |
| `input` | string | ✅ | 自然语言指令，指令前加结束标记 `<|endofprompt|>`；文本标记如 `[laughter]`、`[breath]`。长度 [1, 128000] |
| `voice` | string | ❌ | 音色，如 `FunAudioLLM/CosyVoice2-0.5B:alex` |
| `references` | array | ❌ | 参考音色（与 `voice` 互斥） |
| `response_format` | string | ❌ | `mp3` / `opus` / `wav` / `pcm`，默认 `mp3` |
| `sample_rate` | number | ❌ | 默认 32000 |
| `stream` | boolean | ❌ | 是否流式输出 |
| `speed` | number | ❌ | 语速 [0.25, 4.0]，默认 1 |
| `gain` | number | ❌ | 增益，范围 [-10, 10] |

**sample_rate 支持范围：**

| 格式 | 支持的采样率 |
|------|-------------|
| opus | 48000 Hz |
| wav / pcm | 8000, 16000, 24000, 32000, 44100 Hz（默认 44100） |
| mp3 | 32000, 44100 Hz（默认 44100） |

### 响应格式（200 OK）

返回音频二进制数据（`response` 为 file，格式 `binary`）。

### 调用示例

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/audio/speech \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fnlp/MOSS-TTSD-v0.5",
    "input": "你站在桥上看风景，看风景的人在楼上看你。明月装饰了你的窗子，你装饰了别人的梦",
    "voice": "fnlp/MOSS-TTSD-v0.5:alex",
    "response_format": "mp3"
  }' --output output.mp3
```

```python
import requests

url = "https://api.siliconflow.cn/v1/audio/speech"
payload = {
    "model": "fnlp/MOSS-TTSD-v0.5",
    "input": "你站在桥上看风景，看风景的人在楼上看你。明月装饰了你的窗子，你装饰了别人的梦",
    "voice": "fnlp/MOSS-TTSD-v0.5:alex",
    "response_format": "mp3"
}
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

response = requests.post(url, json=payload, headers=headers)
with open("output.mp3", "wb") as f:
    f.write(response.content)
```

---

## 二、Upload a Voice（上传自定义语音）

### 接口信息

- **方法**: POST
- **路径**: `/v1/uploads/audio/voice`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

上传用户自定义的语音风格，支持 base64 编码或文件格式。

### 请求参数

**Base64 方式：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 预定义语音风格模型名，如 `FunAudioLLM/CosyVoice2-0.5B` |
| `customName` | string | ✅ | 用户自定义语音风格名 |
| `text` | string | ✅ | 音频对应的文本内容 |
| `audio` | string | ❌ | base64 编码的音频，格式 `data:audio/mpeg;base64` |

**文件上传方式：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 预定义语音风格模型名 |
| `customName` | string | ✅ | 用户自定义语音风格名 |
| `text` | string | ✅ | 音频对应的文本内容 |
| `file` | file | ✅ | 上传的音频文件（binary） |

### 响应格式（200 OK）

```json
{
  "uri": "speech:your-voice-name:xxx:xxx"
}
```

### 调用示例

```bash
curl -X POST "https://api.siliconflow.cn/v1/uploads/audio/voice" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@test.mp3" \
  -F "model=IndexTeam/IndexTTS-2" \
  -F "customName=your-voice-name" \
  -F "text=慢工出细活，再给我两分钟，你马上就能见识到超梦分析的厉害了"
```

```python
import requests

url = "https://api.siliconflow.cn/v1/uploads/audio/voice"
headers = {"Authorization": "Bearer YOUR_API_KEY"}
files = {"file": open("test.mp3", "rb")}
data = {
    "model": "IndexTeam/IndexTTS-2",
    "customName": "your-voice-name",
    "text": "慢工出细活，再给我两分钟，你马上就能见识到超梦分析的厉害了"
}

response = requests.post(url, headers=headers, files=files, data=data)
print(response.text)
```

---

## 三、List Voices（列出自定义语音）

### 接口信息

- **方法**: GET
- **路径**: `/v1/audio/voice/list`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

获取用户自定义的语音风格列表。

### 响应格式（200 OK）

```json
{
  "results": [
    {
      "model": "fishaudio/fish-speech-1.4",
      "customName": "your-voice-name",
      "text": "在一无所知中, 梦里的一天结束了，一个新的轮回便会开始",
      "uri": "speech:your-voice-name:xxx:xxx"
    }
  ]
}
```

### 调用示例

```bash
curl --request GET \
  --url https://api.siliconflow.cn/v1/audio/voice/list \
  --header 'Authorization: Bearer YOUR_API_KEY'
```

---

## 四、Delete a Voice（删除自定义语音）

### 接口信息

- **方法**: POST
- **路径**: `/v1/audio/voice/deletions`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

删除用户自定义的语音风格。

---

## 五、Create a Audio Transcription（音频转录 ASR）

### 接口信息

- **方法**: POST
- **路径**: `/v1/audio/transcriptions`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

将音频转录为文本。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | ✅ | 音频文件对象，限制：**时长不超过 1 小时，文件大小不超过 50MB** |
| `model` | string | ✅ | 模型：`FunAudioLLM/SenseVoiceSmall` / `TeleAI/TeleSpeechASR` |

### 响应格式（200 OK）

```json
{
  "text": "string"
}
```

### 调用示例

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/audio/transcriptions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@path/to/your/audio.mp3" \
  -F "model=FunAudioLLM/SenseVoiceSmall"
```

```python
import requests

url = "https://api.siliconflow.cn/v1/audio/transcriptions"
headers = {"Authorization": "Bearer YOUR_API_KEY"}
with open("path/to/your/audio.mp3", "rb") as audio_file:
    files = {
        "file": ("audio.mp3", audio_file),
        "model": (None, "FunAudioLLM/SenseVoiceSmall")
    }
    response = requests.post(url, headers=headers, files=files)
    print(response.text)
```

---

## 错误响应示例（通用）

| 状态码 | 示例响应 |
|--------|----------|
| 400 | `{"code": 20012, "message": "string", "data": "string"}` |
| 401 | `"Invalid token"` |
| 403 | `"Forbidden"` |
| 404 | `"404 page not found"` |
| 429 | `{"message": "Request was rejected due to rate limiting...", "data": "string"}` |
| 503 | `{"code": 50505, "message": "Model service overloaded. Please try again later.", "data": "string"}` |
| 504 | `"string"` |
