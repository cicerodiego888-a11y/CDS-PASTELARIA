# INVENTÁRIO DE ESTOQUE EMPRESARIAL — Sprint 05.47

**Data:** 2026-08-25

Classificação:

- **A** — seguro (empresa na chave da operação)
- **B** — seguro por vínculo estrutural confiável
- **C** — compatibilidade intencional
- **D** — corrigido nesta sprint
- **E** — fora do escopo

## Tabelas

| Tabela | empresa_id? | produto_id? | Vínculo indireto | Índice empresarial | Legado NULL | Unicidade | Classe |
|--------|-------------|-------------|------------------|--------------------|-------------|-----------|--------|
| `produtos` | não | PK | catálogo compartilhado | n/a | n/a | SKU global (intencional) | C |
| `estoque_empresa` | sim | sim | — | UNIQUE(produto, empresa) | sem linha = zero | adequada | A |
| `produtos_lotes` | **sim (05.47)** | sim | `compra_id` incompleto | `(empresa_id, produto_id, ativo)` | sim, sem backfill | sem UNIQUE global de lote | D |
| `venda_lotes` | não | via lote | `vendas_itens` → `vendas.empresa_id` | — | lote NULL = ownership required | — | B + D na restauração |
| `pedido_estoque_reservas` | **sim (05.47)** | sim | `pedidos` sem empresa_id | `(empresa_id, produto_id, status)` | sim | — | D |
| `venda_estoque_reservas` | **sim (05.47)** | sim | `vendas.empresa_id` | índice empresa | sim | — | D |
| `vendas` | sim (05.40) | — | — | `idx_vendas_empresa_id` | sim | — | A |
| `compras` | sim (05.38.F) | — | lote criado com empresa da compra | — | — | — | A |
| `produtos_ajustes_estoque` | não | sim | ajuste usa `req.empresaId` na porta | — | — | — | C |
| `movimentos_transferencia_saldos` | — | — | porta F×NF | — | — | — | E |
| `vendas_devolucoes` / `compras_devolucoes` | via origem | sim | 05.42 / 05.38 | — | — | — | B |

Não foi criada coluna duplicada onde o pai já era suficiente (`venda_lotes` continua ligado ao lote e à venda).

## Fluxos de lote / FEFO

| Fluxo | Classe | Nota |
|-------|--------|------|
| `selecionarLoteFefo` / `consumirLotesFEFO` | D | exigem `empresaId`; `ORDER BY validade, id` |
| Baixa de venda (`reduzirEstoqueComFEFO`) | D | passa `opcoes.empresaId` da venda |
| Ajuste positivo/negativo com validade | D | lote/FEFO com `optsPorta.empresaId` |
| Entrada de compra | D | `criarLote` com `opcoes.empresaId` da compra |
| Estoque inicial / sync validade | D | `req.empresaId`; sem empresa não cria lote |
| Restauração cancelamento | D | `WHERE id=? AND empresa_id=?` |
| Restauração devolução parcial | D | mesma regra |
| NF-e devolução de venda (lotes) | D (wiring) | `devolverLotesParcialItem` recebe `optsCredito`; regras fiscais intactas |
| `gerarProximoLote` | C | só nome `LT%` |
| `atualizarEstoqueConsolidado` | E | sem caller |
| Dashboard vencimentos | C | filtro se houver contexto |
| Transformação / ficha técnica | E | não chamam FEFO |

## Fluxos de reserva

| Fluxo | Classe | Nota |
|-------|--------|------|
| `consultarDisponibilidade` + empresa | A | já 03.36 |
| `criarReservaFiscal` | D | dual-write + `empresa_id` + check dentro da TX |
| Reserva PDV `reservarItem` | D | persiste `empresa_id` |
| Liberar pedido | D | espelho na empresa da linha |
| Consumo pedido→venda | D | porta na empresa da reserva |
| `liberarReservasDaVenda` | D | não usa req para escolher dona se linha tem `empresa_id` |
| Motor Comercial criar/liberar | C | não alterado; INSERT legado sem empresa permanece NULL |
| ReservaRepair INSERT | C | Motor; tracking pode nascer sem `empresa_id` |
| COMPAT sem empresa | C | `produtos.reservado_*` apenas |
| Expiração / scheduler | E | inexistente; contrato futuro documentado |

## Leituras

| Fluxo | Classe | Acesso cruzado |
|-------|--------|----------------|
| `obterLoteDaEmpresa` | D | 404 `LOTE_NAO_ENCONTRADO` |
| `obterReservaPedidoDaEmpresa` | D | 404 `RESERVA_NAO_ENCONTRADA` |
| Detalhe de produto + validade | D | lotes só da empresa do contexto |
| `obterProdutoComReserva` | E | sem callers |

## Fora desta sprint

NF-e 55, certificado, CSC, DistDFe, TEF, Motor Comercial, Open Finance, estrutura global de produtos, UI do PDV, scheduler de expiração.
