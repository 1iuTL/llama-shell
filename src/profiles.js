// 任务档位定义。
//
// 为什么需要档位:同一套采样参数不可能同时适合推理和创作。
// 实测(见 README)同一模型下:
//   - 推理档(开思考 + temp 0.7)解数学题最快(10.6s),但**写小说输出为空** ——
//     思考把整个 token 预算吃光了,这是"用错档位直接失败",不是差一点
//   - 通用档(关思考)创作任务反而写得最长(889 字),数学题也答对
//   - 写作档(高温度 + 重复惩罚)在创作上表现稳定,692 字
//
// 所以档位不是"调优",而是避免用错。默认用「通用」。
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
