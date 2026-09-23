// 任务档位定义。
//
// 为什么需要档位:同一套采样参数不可能同时适合推理和创作。
//
// ⚠️ 这里曾经写着"推理档写小说输出为空 —— 思考把整个 token 预算吃光了",
// 并把它当成档位的固有缺陷。**那个结论是错的,至少是过度概括。**
// 复测(2026-09,同一道几何题、同一模型、官方 prism 构建):
//
//   max_tokens=2048 + 开思考 -> reasoning 434 字符 + content 389 字符  正常
//   max_tokens=256  + 开思考 -> reasoning 348 字符 + content 108 字符  仍可用
//
// 也就是说:思考**不会**必然吃光预算,它只是先花掉一部分。当初得到"输出为空"
// 有两个叠加原因,都不是档位本身的问题:
//   1. 当时测试的 max_tokens 很小(600 量级),思考写完就没余量了
//   2. 当时**用错了 llama.cpp 构建**(社区 fast fork 跑三值模型会塌缩成连续
//      斜杠)—— 那才是真凶,详见 src/config.js 里 fork 配对的说明
//
// 现在的做法不是靠"默认关掉思考"来规避,而是给用户一个**随时可切的入口**
// (代理会往 Web UI 注入一个档位面板,见 ui-inject.mjs),用错档的成本从
// "这轮废了"降到"点一下重来"。
//
// 实测(解题速度):推理档最快,思考内容不长且直接给答案;其它三档回答更长。
// 所以档位的意义是"按任务选",不是"某档有毛病"。
//
// 关键约束:llama.cpp 的 Web UI 会在**请求里**自带采样参数,而请求级优先于
// 服务端启动参数(实测:请求里 t=0.01 时三次输出完全相同,证明请求确实生效)。
// 因此档位必须在**请求层**覆盖 —— 只改命令行不起作用。
module.exports = {
  profiles: [
    {
      key: 'chat',
      label: '通用',
      hint: '日常问答与创作,平衡取向',
      // 实测:创作任务里这个档写得最长(889 字),数学题也答对
      params: {
        temperature: 0.8,
        top_p: 0.95,
        top_k: 30,
        repeat_penalty: 1.08,
        presence_penalty: 0.2,
      },
      thinking: false,
    },
    {
      key: 'reason',
      label: '推理',
      hint: '数学与逻辑,开思考、低温度',
      params: {
        temperature: 0.7,
        top_p: 0.95,
        top_k: 20,
      },
      thinking: true,
    },
    {
      key: 'write',
      label: '写作',
      hint: '长文与创意,高温度 + 重复惩罚',
      params: {
        temperature: 1.05,
        top_p: 0.95,
        top_k: 40,
        repeat_penalty: 1.12,
        presence_penalty: 0.3,
      },
      thinking: false,
    },
    {
      key: 'code',
      label: '代码',
      hint: '写代码与排错,关思考、低温度',
      params: {
        temperature: 0.5,
        top_p: 0.95,
        top_k: 20,
      },
      thinking: false,
    },
  ],
  defaultProfile: 'chat',

  /** 按 key 取档位;找不到就回落到默认档。 */
  resolve(key) {
    const list = module.exports.profiles
    return list.find((p) => p.key === key) || list.find((p) => p.key === module.exports.defaultProfile) || list[0]
  },
};
