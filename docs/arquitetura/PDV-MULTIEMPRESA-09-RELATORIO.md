# PDV-MULTIEMPRESA-09 — Homologação integrada pós-M08

**Data:** 2026-10-26  
**Pré-requisito:** PDV-MULTIEMPRESA-08 (Opção A — buckets exclusivos)  
**Tipo:** Validação integrada (sem alteração de regras de produção)  
**Estado final:** **CONCLUÍDA** (cenários com evidência reproduzível; canais classificados)

## 1. Objetivo

Comprovar que o seletor Multiempresa e o Motor F×NF permanecem alinhados após M08, sem novas regras de negócio, instalador ou acesso a banco oficial.

## 2. Versão testada

| Artefato | Valor |
|---|---|
| `package.json` | `1.0.3` |
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD git | `ffce987` |
| Código efetivo | **Worktree** (M08 em `distribuidorEstoqueVenda.js` + `pdv.js`; seletor untracked) |
| Instalador Setup 1.0.3 | **Não** revalidado / **não** regenerado |

Homologação desta sprint = worktree (`node --test` / fonte atual). O binário instalado permanece potencialmente defasado (ver M06).

## 3. Cenários obrigatórios (sintéticos `:memory:`)

Suite: `tests/pdv/pdv-multiempresa-09-homologacao-pos-m08.test.js` → **12 pass / 0 fail**.

| ID | Cenário | Resultado | Evidência |
|---|---|---|---|
| C1 | Fiscal + saldo fiscal suficiente | **PASS** | Seletor escolhe matriz; motor `qF=qty`, `qNF=0` |
| C2 | Fiscal + só NF | **PASS** | Seletor `NENHUMA_EMPRESA_ATENDE`; motor `sucesso:false` |
| C3 | Não fiscal + NF suficiente | **PASS** | Seletor OK; motor `qNF=qty`, `qF=0` |
| C4 | Não fiscal + só fiscal | **PASS** | Ambos bloqueiam |
| C5 | Qty > bucket exigido | **PASS** | Bloqueio; sem `quantidadeFiscal` parcial no unitário; pipeline sem `itens` |
| C6 | Carrinho misto `tipo_saldo` na mesma empresa | **PASS** | Matriz atende F+NF explícitos; cruzado bloqueia |
| C7 | Ficha técnica total F+NF | **PASS** | Insumo só NF atende acabado fiscal (contrato vigente) |
| C8 | Nenhuma empresa; sem soma CNPJs | **PASS** | 2+2+2 &lt; necessidade agregada por empresa; `atendeIntegralmente=false` em todas |
| C9 | Revalidação pré-finalização | **PASS** | 1ª OK; após baixa sintética → 409; motor também falha |
| C10 | Mensagem PDV = motivo efetivo | **PASS** | `mensagem` com gargalo `ESTOQUE_INSUFICIENTE_FISCAL`; banner/fetch usam `data.mensagem` |

### Evidência C10 (contrato HTTP 409 equivalente)

- `code`: `NENHUMA_EMPRESA_ATENDE`
- `mensagem`: inclui base (“não será dividida entre CNPJs”) + gargalos (`produto … ESTOQUE_INSUFICIENTE_FISCAL`)
- UI (`pdv.js`): `renderBannerSelecaoEmpresaPdv` e `atualizarSelecaoEmpresaPdv` propagam `data.mensagem || data.error` (leitura estática + simulação do texto do banner)

Network Electron ao vivo: **não** capturado nesta sprint (sem sessão autenticada / sem DB oficial). Contrato de código + suite cobrem o caminho.

## 4. Canais afetados — classificação

| Canal | Verificação nesta sprint | Classificação |
|---|---|---|
| PDV oficial `/pdv` | C1–C10 (seletor + motor + mensagem) | **Homologado** (sintético / contrato) |
| `CriarVendaEntregaService` | Contrato: chama `distribuirItensVendaComValorFiscalEfetivo` + `emitir_fiscal`; motor exclusivo comprovado no mesmo núcleo | **Homologado em contrato** — E2E HTTP/entrega **pendente** |
| Faturamento / expedição | `FaturamentoService` → `VendaApplicationService` com `venda_fiscal`; distribuição no `VendaPagamentoService` (mesmo motor) | **Homologado em contrato** — E2E pedido/expedição **pendente** |
| PDV Universal | Fora de escopo | Não modificado / não homologado |
| Setup instalador 1.0.3 | Não regenerado | **Pendente** build pós-revisão TL |

### Limitação documentada (sem correção — restrição da sprint)

`CriarVendaEntregaService` ainda formata erro com `Disponível: ${erro.estoqueTotal}` (total), não `disponivelBucket`. O **bloqueio** do motor M08 está correto; a UX da mensagem de entrega pode ser menos precisa que a do seletor PDV. Melhoria de mensagem = sprint futura autorizada.

## 5. Regressões direcionadas (sequenciais)

```text
node --test tests/pdv/pdv-multiempresa-09-homologacao-pos-m08.test.js → 12 pass
node --test tests/pdv/pdv-multiempresa-08-motor-bucket-exclusivo.test.js → 11 pass
node --test tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js → 12 pass
node --test tests/muv/muv-cap-01-capacidade-selecao.test.js → 10 pass
node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js → 18 pass
```

Isolamento: `:memory:` / leitura estática. Sem `CDS_ALLOW_OFFICIAL_DB`, sem SEFAZ, sem vendas reais. **Nenhuma** alteração de regra de produção nesta sprint.

## 6. Pendências

1. E2E Entrega e Faturamento/expedição com harness HTTP isolado (autorização TL).
2. Captura Network real no Electron worktree (opcional, procedimento M06 §9).
3. Build/instalador incluindo seletor + M08 — só após revisão do Tech Lead.
4. UX mensagem Entrega (`estoqueTotal` vs bucket) — opcional, fora desta sprint.

## 7. Encerramento

Cenários C1–C10 com evidências reproduzíveis; PDV homologado sintético; Entrega e Faturamento classificados como homologados em contrato / E2E pendente; sem build automático.

**Estado: CONCLUÍDA**  
Aguardar revisão do Tech Lead antes de homologação operacional ou entrega de produção.
