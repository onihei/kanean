import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ok, problem } from '../result.js'
import type { LinkedService, ServiceCatalogEntry } from '../apiTypes.js'
import { bookArg, defineTool, type ToolDeps } from './register.js'

/**
 * 連携サービス（EC・銀行・カード）の一覧と登録。
 *
 * **登録がこのサーバで唯一の書き込み**（mcp-server spec「書き込みの限定と承認の非委譲」）。
 * 補助科目の採番を伴うので、勝手に決めず候補を提示して確認を得る。
 */

export function registerServiceTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'list_linked_services',
    {
      title: '連携サービス一覧',
      description:
        '登録済みの連携サービス（EC・銀行口座・カード）と、登録できるサービスの候補を返す。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const [{ services }, { catalog }] = await Promise.all([
        call<{ services: LinkedService[] }>('/api/services'),
        call<{ catalog: ServiceCatalogEntry[] }>('/api/services/catalog'),
      ])

      const registeredKeys = new Set(services.map((s) => s.serviceKey))
      const available = catalog.filter((entry) => !registeredKeys.has(entry.key))

      return ok({
        data: {
          registered: services,
          // まだ登録していないもの＝register_linked_service に渡せる候補。
          registerable: available,
        },
        counts: { registered: services.length, registerable: available.length },
        nextActions:
          services.length === 0
            ? ['連携サービスが未登録。候補から選んで kanean_register_linked_service で登録する']
            : [],
      })
    },
  )

  defineTool(
    server,
    deps,
    'register_linked_service',
    {
      title: '連携サービスを追加',
      description:
        '連携サービス（EC・銀行口座・カード）を登録する。補助科目が自動で作られる。' +
        'serviceKey は kanean_list_linked_services が返す候補から選ぶ。' +
        '**どのサービスを登録するかは利用者に確認してから呼ぶこと**。',
      inputSchema: {
        serviceKey: z
          .string()
          .describe('カタログの key（例: amazon / rakuten / bank_ufj / card_mufg_visa）'),
        name: z
          .string()
          .optional()
          .describe('表示名。省略するとカタログの既定名になる（同種を複数持つときに指定する）'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      const { catalog } = await call<{ catalog: ServiceCatalogEntry[] }>('/api/services/catalog')
      const entry = catalog.find((c) => c.key === args.serviceKey)

      // 未対応キーで本体に 400 を投げさせるより、選べる候補を返すほうが人の手数が減る。
      if (!entry) {
        return problem(`「${args.serviceKey}」は登録できる連携サービスにありません。`, {
          code: 'unknown_service_key',
          data: { registerable: catalog },
          nextActions: ['候補から利用者に選んでもらい、その key で登録し直す'],
        })
      }

      const { service } = await call<{ service: LinkedService }>('/api/services', {
        method: 'POST',
        body: { serviceKey: args.serviceKey, name: args.name ?? null },
      })

      return ok({
        data: service,
        nextActions: [
          `${service.accountName} の補助科目「${service.name}」として登録した（accountRef: ${service.accountRef}）`,
          '明細の取込は Kanean の「連携サービス」画面から行う',
        ],
        openInApp: 'services',
      })
    },
  )
}
