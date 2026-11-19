# Evidência S07-3D — Contrato, fluxos e persistência

## Proposta de persistência (aprovada na implementação)

| Campo | Origem | Papel |
|-------|--------|--------|
| `pedidos.origem_canal` | já existente (`pedidosOrigemSchema`) | Canal do adaptador de entrada (`EQUIPE`, etc.) |
| `pedidos.cozinha_canal_codigo` | **novo** (migration S07-3D) | Canal de cozinha efetivo na resolução (`LOJA`, `IFOOD`, …) |
| `pedidos.unidade_cozinha_destino_id` | **novo** | Snapshot da unidade resolvida |
| `pedidos.cozinha_resolucao_status` | **novo** | `RESOLVIDO` / `DESTINO_NAO_CONFIGURADO` / … |

Migration: `backend/migrations/s07-3d-pedido-destino-cozinha.sql` — **não executada no banco oficial**.

Schema helper (testes): `backend/utils/pedidosDestinoCozinhaSchema.js` (`garantir*` apenas em testes).

## Fluxos reais de entrada identificados

| Fluxo | Arquivo | Origem |
|-------|---------|--------|
| POST `/api/pedidos` | `backend/rotas/pedidos.js` → `EntradaPedido.receber({ canal: EQUIPE })` | Adaptador `EQUIPE` → resolução `LOJA` |
| POST `/api/pedidos/venda-por-valor-pasteis` | mesma cadeia via Entrada `EQUIPE` | Idem |
| POST `/api/faturamento/pedidos` | `PedidoService.criarPedido` → operacional **sem** `origemCanal` | Sem resolução (sem origem) |
| Integrações iFood/WhatsApp | **inexistentes** nesta base | Serviço pronto para receber o código do canal |

Canal **nunca** vem do body do cliente (`EntradaPedidoService`).

## Contrato do serviço

`CozinhaResolucaoDestinoService.resolverDestinoPedido({ empresaId, canalCodigo, …Ignored })`

Retorno estruturado (`status` / `codigo`):

- `RESOLVIDO`
- `DESTINO_NAO_CONFIGURADO` (pendente, sem fallback)
- `CANAL_INEXISTENTE`
- `CANAL_INATIVO`
- `UNIDADE_DESTINO_INVALIDA`
- `SCHEMA_CANAIS_INDISPONIVEL`
- `CANAL_ORIGEM_OBRIGATORIO`

Campo `despacho: false` sempre. Sem chamada a `CozinhaDespachoService`.

## Integração

Em `PedidoOperacionalService.criar`, após insert do pedido (com `origemCanal`):

1. Resolve destino com empresa do contexto.
2. Ignora `empresa_id` / `unidade_*` / `destino` do body.
3. Persiste snapshot se colunas existirem.
4. Não sobrescreve pedido já `RESOLVIDO`.
5. Falha de resolução **não** aborta criação comercial.
