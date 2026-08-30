import {
  FieldType,
  fieldDecoratorKit,
  FormItemComponent,
  FieldExecuteCode,
  AuthorizationType,
} from 'dingtalk-docs-cool-app';

const { t } = fieldDecoratorKit;

/**
 * 「AI 生成文本」字段 —— 复刻钉钉内置「生成文本」形态的 FaaS 收费上架版：
 *   · 自定义 AI 任务指令（Textarea + enableFieldReference，即「插入字段」）
 *   · 输出篇幅（Radio：一句话 / 一段话 / 要点式，映射网关 style）
 *   · 输出文本（resultType: Text）
 * execute 把指令（客户端已把引用字段值内联进来）以 capability=generate_text
 * 发给自有网关 z.5209.top/v1/compose，网关按租户授权码鉴权 + 额度计量后调千问，回填文本。
 *
 * 这是「按授权收费」的上架版本：authorizations 已打开（required:true），
 * 客户必须在「关联你的服务账号」里填你发的授权码才能用，拿不到 key 就用不了。
 *
 * 输出不追加任何 AI 标识后缀（网关 .env 的 AI_DISCLAIMER 置空即可）。
 *
 * ⚠️ 用钉钉「AI 字段开发助手 → FaaS 调试」测试时，需临时把下面整个 authorizations 块注释掉、
 *    并把 fetch 第三个参数 AUTH_ID 去掉（调试助手不支持授权，required:true 会让「添加字段」报
 *    「文档错误，数据已保存」）。提交上架仓库时保持本文件的 authorizations 处于启用状态。
 */

// 域名必须有 DNS 解析记录（z.5209.top 实测可解析）；网关只暴露 /v1/compose
const ENDPOINT = 'https://z.5209.top/v1/compose';
const AUTH_ID = 'gateway_key';

fieldDecoratorKit.setDomainList(['z.5209.top']);

fieldDecoratorKit.setDecorator({
  name: 'AI 生成文本',

  // 关闭被动自动更新：被引用字段一变就重跑会持续烧网关额度。
  options: { disableAutoUpdate: true },

  i18nMap: {
    'zh-CN': {
      instructionLabel: '自定义 AI 任务指令',
      lengthLabel: '输出篇幅',
    },
    'en-US': {
      instructionLabel: 'Custom AI instruction',
      lengthLabel: 'Output length',
    },
  },

  // 自定义错误文案：execute 返回的 errorMessage 必须是这里的 key（仅 code=Error 生效）。
  // ⚠ 值必须写中文字面量：${{}} 占位符只在 formItems[].label 生效。
  errorMessages: {
    gateway_error: '生成失败，服务暂时不可用，请稍后重试',
  },

  // 收租阀门：钉钉代管客户授权码，调 fetch 传第三个参数 AUTH_ID 才会注入 Authorization: Bearer
  authorizations: {
    id: AUTH_ID,
    platform: '念晴科技', // 授权面板上给客户看的平台名，换品牌只改这一行
    type: AuthorizationType.HeaderBearerToken,
    required: true,
    label: '关联你的服务账号',
    tooltips: '还没有授权码？点击右侧链接获取',
    instructionsUrl: 'https://z.5209.top/get-key',
  },

  formItems: [
    {
      key: 'instruction',
      label: t('instructionLabel'),
      component: FormItemComponent.Textarea,
      props: {
        // placeholder / tooltips 一律写中文字面量（非 label 位置的 ${{}} 不会被解析）
        placeholder:
          '根据以下提供的关键词或主题，撰写一段内容。\n注意：不要输出额外内容。\n主题或关键词：',
        // 开启后文本框内出现「插入字段」按钮，用户可把当前行字段值内联进指令
        enableFieldReference: true,
      },
      validator: { required: true },
      tooltips: {
        title:
          '用自然语言描述要生成什么；点「插入字段」可把当前行某列的值嵌进指令里。切勿引用本字段自己的结果列，否则输出会越滚越长。',
      },
    },
    {
      key: 'length',
      label: t('lengthLabel'),
      component: FormItemComponent.Radio,
      props: {
        defaultValue: 'para',
        options: [
          { value: 'one', label: '一句话' },
          { value: 'para', label: '一段话' },
          { value: 'bullets', label: '要点式' },
        ],
      },
      validator: { required: true },
      tooltips: { title: '控制生成内容的长短：一句话最简，要点式适合清单呈现' },
    },
  ],

  // 输出文本，与 execute 返回的 data: string 对齐
  resultType: { type: FieldType.Text },

  execute: async (
    context,
    formData: { instruction?: string; length?: string },
  ) => {
    // 兜底：命令行裸调 /open_field_card 或异常入参时 formData 可能为空
    const fd = formData || {};
    const instruction = (fd.instruction || '').trim();

    // 配置合法但内容为空 —— 用 InvalidArgument，失败返回值不带 data、不写 errorMessage
    if (!instruction) {
      return { code: FieldExecuteCode.InvalidArgument, msg: 'instruction is empty' };
    }

    const payload = {
      capability: 'generate_text',
      style: fd.length || 'para',
      instruction,
      items: [],
    };

    try {
      const res = await context.fetch(
        ENDPOINT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          // 必须大于网关 REQ_TIMEOUT_MS(120s)，否则两边同时超时抢跑；仍远小于沙箱 15 分钟
          timeout: 150000,
        },
        AUTH_ID, // 上架版：注入客户授权码 Bearer（调试时注释掉本行）
      );

      const status = res?.status ?? 0;
      if (status === 401 || status === 403) {
        return {
          code: FieldExecuteCode.AuthorizationError,
          msg: '授权码无效或已停用，请到「关联你的服务账号」里重新填写',
        };
      }
      if (status === 429) {
        return { code: FieldExecuteCode.RateLimit, msg: '调用过于频繁，稍后自动重试' };
      }
      if (status === 402) {
        return { code: FieldExecuteCode.QuotaExhausted, msg: '今日额度已用完，次日自动恢复' };
      }

      const json = await res.json();
      if (!json || typeof json.text !== 'string' || !json.text.trim()) {
        return {
          code: FieldExecuteCode.Error,
          errorMessage: 'gateway_error',
          extra: { logId: context.logId, traceId: json?.traceId ?? 'n/a', reason: 'empty reply text' },
        };
      }
      return { code: FieldExecuteCode.Success, data: json.text.trim() };
    } catch (error) {
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'gateway_error',
        extra: { logId: context.logId, reason: String((error as Error)?.message ?? error) },
      };
    }
  },
});

export default fieldDecoratorKit;
