# AUDITORIA — Fluxo completo do Pedido

## 4.1 Pesquisa e seleção

| Aspecto | Fato |
|---|---|
| Endpoint | `GET /api/produtos/consulta-pedido/buscar` |
| Serviço | `PedidoConsultaProdutosService.buscarProdutosParaPedido` |
| Fontes | (A) MIB comerciais origem `pdv`; (B) insumos `comercializavel=1` |
| Diferenciação | Campo `tipo_operacional` / `origem_cadastro` no item retornado |
| Refrigerante | Fonte B (INSUMO); comerciais categoria Refrigerantes filtrados |
| Pastel | Fonte A (COMERCIAL), tipicamente sem filtro especial além do MIB |
| Quantidade/volume | UI envia quantidade; produtos com `utiliza_volume` carregam volume_* |
| Inativos / não comercializáveis | Insumos: `ativo=1` e `comercializavel=1` obrigatórios na SQL B |
| PDV vs Pedido | `consulta-pdv/buscar` **não** mescla insumos comercializáveis |

UI: `frontend/erp/js/pedidos.js`, `frontend/mobile-pedido/mobile-pedido.js`.

## 4.2 Montagem

- Item identificado por `produto_id` (sempre PK de `produtos` — COMERCIAL ou INSUMO no **mesmo** espaço de IDs).
- Não há segundo cadastro: não há “mistura de IDs de tabelas diferentes”; o risco é semântico (tipo), não de namespace.
- Personalização: `ingredientes_selecionados[]` → `PedidoPersonalizacaoService.prepararItens`.
- Observações: campo do item/pedido conforme payload operacional.
- Exclusão de item na edição: `PedidoRepository` faz `DELETE` das linhas não reenviadas (+ ingredientes).

## 4.3 Persistência
Ver `AUDITORIA-PERSISTENCIA.md`.

## 4.4 Ciclo de vida

Status (`backend/services/pedido/enums.js`):

```
ORCAMENTO → PEDIDO → AGUARDANDO_FATURAMENTO → FATURADO | CANCELADO
(+ legado ABERTO / EM_SEPARACAO)
```

| Etapa | Serviço / fato |
|---|---|
| Criação/edição | `PedidoOperacionalService` + `PedidoRepository.criarPedido` / atualização de itens |
| Reserva estoque | `PedidoConsumoEstoqueService.reservarConsumo` (após gravar, em fluxos que reservam) |
| Cancelamento | `PedidoOperacionalService.cancelar` → status `CANCELADO` (+ estorno quando aplicável) |
| Exclusão de linhas | DELETE em `pedidos_itens` (não soft-cancel) |
| Mesa/atendimento | `mesa_id`, `mesa_atendimento_id`; serviços em `MesaAtendimentoService` |
| Envio preparação legado | `PedidoPreparacaoService` (status enviáveis PEDIDO/ABERTO/EM_SEPARACAO) — **não** é Cozinha V1 despacho |
| Conversão venda | Fluxos de faturamento / Motor Comercial / ponte reserva |
| Confirmação Pedido ≠ preparação Cozinha ≠ venda fiscal | Distintos no código |

## Confirmação vs preparação vs venda
- **Confirmar/salvar Pedido:** grava comercial + eventualmente reserva estoque.
- **Despacho Cozinha (Sprint 02):** lê pedido já gravado; não altera PDV/composição.
- **Venda/faturamento:** consome reservas / emite documento — fora do escopo Cozinha S02.
