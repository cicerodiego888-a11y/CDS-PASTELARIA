# MATRIZ DE INVARIANTES EMPRESARIAIS — Sprint 05.48

**Status:** auditoria  
**Data:** 2026-08-25

Fonte de verdade: **ownership persistido da operação**. Contexto HTTP / JWT / header só **autoriza**.

Proibido como fonte de ownership: `req.empresaId` substituto, empresa do usuário, última empresa/sessão, COMPAT global, primeiro registro/lote, config fiscal global, fallback implícito.

---

## Por domínio

| Domínio | Fonte de verdade | Contexto atual | Cruzado | NULL legado | Classe |
|---------|------------------|----------------|---------|-------------|--------|
| Sessão de caixa | `caixa_sessoes.empresa_id` | autoriza operação naquela sessão | 403 `CAIXA_SESSAO_EMPRESA_DIVERGENTE` / 404 | `EMPRESA_OWNERSHIP_REQUIRED` / sessão invisível | A |
| Venda | `vendas.empresa_id` | autoriza leitura/reversão | 404 `VENDA_NAO_ENCONTRADA` | `EMPRESA_OWNERSHIP_REQUIRED` | A |
| Estoque operacional | `estoque_empresa` (empresa+SKU) | autoriza consulta/baixa | saldo 0 / registro ausente | COMPAT só em helpers não usados no PDV novo | A / C helper |
| Lote / FEFO | `produtos_lotes.empresa_id` | autoriza consumo/restauração | 404 `LOTE_NAO_ENCONTRADO` | ilegível no FEFO empresarial | A |
| Reserva pedido (porta 05.47) | `pedido_estoque_reservas.empresa_id` | autoriza | 404 `RESERVA_NAO_ENCONTRADA` | `EMPRESA_OWNERSHIP_REQUIRED` na liberação | A |
| Pedido comercial | **não persistido** | caller / Motor opts | N/A | N/A | D |
| Reserva Repair | INSERT sem `empresa_id` | COMPAT se sem empresa | mistura possível via tracking NULL | LEGADO_NULL criado em runtime | D |
| Financeiro | `financeiro.empresa_id` da origem venda/compra/caixa | autoriza baixa | 404 | 404 (não inventa) | A |
| NFC-e | `vendas.empresa_id` → config `fonte=EMPRESA` | autoriza | 404 | `EMPRESA_OWNERSHIP_REQUIRED` | A |
| NF-e 55 / DistDFe | config global se `getFiscalConfig()` sem empresa | — | possível mistura de CNPJ | — | E |
| Cancelamento / devolução | `vendas.empresa_id` | autoriza | 404 | bloqueia antes de estoque/financeiro | A |
| Dashboard caixa | sessão da empresa do contexto | sem empresa → bloco vazio | não lista sessão de outra empresa | sessão NULL some | A / C proxy venda |

---

## Transições (resumo)

| ID | Transição | Classe | Quebra se… |
|----|-----------|--------|------------|
| T01 | Empresa → sessão | A | SQL de sessão sem `empresa_id` |
| T02 | Sessão → venda | A | INSERT venda com outra empresa ou sem coluna |
| T03 | Venda → estoque | A | débito com `req` depois da persistência; hoje create usa o mesmo id |
| T04 | Venda → FEFO | A | FEFO só por SKU |
| T05 | Pedido → reserva | D | confirmar pedido sem dono; Repair INSERT sem coluna |
| T06 | Reserva → estoque | A/C | dual-write só em `produtos` globais; NULL no tracking |
| T07 | Venda → financeiro | A | INSERT financeiro sem `empresa_id` da venda |
| T08 | Venda → NFC-e | A | CSC/cert global; `fonte !== EMPRESA` |
| T09 | Cancelamento | A | estoque/financeiro com `req.empresaId` |
| T10 | Devolução | A | lote/financeiro da empresa do header |

---

## Classificação de persistência (DB vivo `mercadao.db`, 2026-08-25)

Consulta somente leitura. **Sem backfill.**

| Tabela | Total | `empresa_id` NULL | Classificação |
|--------|------:|------------------:|---------------|
| `vendas` | 20 | 20 | LEGADO_NULL — 05.40 não classificou (caixa/MUV sem dono) |
| `financeiro` | 20 | 20 | LEGADO_NULL — 05.41 via venda também NULL |
| `caixa_sessoes` | 5 | 5 | LEGADO_NULL |
| `produtos_lotes` | 0 | 0 | vazio |
| `pedido_estoque_reservas` | 0 | 0 | vazio |
| `venda_estoque_reservas` | 0 | 0 | vazio |
| `compras` | 0 | 0 | vazio |
| `contas_receber` | 0 | 0 | vazio |
| `nfce_notas` | 1 | coluna ausente | INDIRETO_CONFIÁVEL via `venda_id` (venda provavelmente NULL) |
| `pedidos` | 0 | coluna ausente | AMBÍGUO / RISCO estrutural (T05) |
| `vendas_devolucoes` | — | coluna ausente | INDIRETO via `venda_id` |

Operações novas (pós 05.40–05.47) persistem `empresa_id` quando o caller informa empresa. O acervo atual deste banco **não** é operável em cancel/dev/NFC-e até classificação humana.

---

## Fallbacks e queries globais encontrados (não corrigidos)

| Padrão | Onde | Classe | Nota |
|--------|------|--------|------|
| `SELECT * FROM vendas WHERE id = ?` | cancel/dev | B | check de ownership imediatamente depois |
| `SELECT ... financeiro WHERE id = ?` | baixa financeiro | B | `exigirLancamentoDaEmpresa` depois |
| `getFiscalConfig()` sem `empresaId` | DistDFe, `nfeEmissorVenda`, centrais | E/C | NFC-e de venda **não** usa este caminho |
| `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` | Motor Comercial | C | explícito; nunca empresa 1 |
| `COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA` | ReservaRepair | C | + INSERT D |
| `COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` | `debitoEstoqueVendaViaPorta` | C | não no `criarVenda` |
| `gerarProximoLote` `LT%` global | `lotesService` | C | só código |
| `LIMIT 1` sessão | `montarSqlSessaoAberta` | A | sempre com `empresa_id` |
| Dashboard vendas da sessão | `CaixaProvider` filtra `cs.empresa_id`, não `v.empresa_id` | C proxy | OK se T02 for verdadeiro |

Nenhum fallback silencioso para empresa 1 / último CNPJ / usuário como dono foi encontrado nos escritores da cadeia PDV auditada.
