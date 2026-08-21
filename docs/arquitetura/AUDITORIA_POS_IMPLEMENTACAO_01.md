# AUDITORIA PÓS-IMPLEMENTAÇÃO 01
## Porta Pública de Saldos + Contexto de Empresa
**CDS Sistemas — Pastelaria — Fase 1 Fundação Multiempresa**  
**Status:** somente leitura · **Data:** 2026-08-12  
**Escopo:** estado REAL do código após Implementação 01

---

## 1. Resumo executivo

A Implementação 01 **atingiu o objetivo declarado**: a porta pública F×NF passou a exigir `empresaId`/contexto (ou compat **explícita**), MTS e Motor Comercial propagam esse contexto, e os motores de distribuição/venda/cancelamento **não** foram reescritos.

Porém o **isolamento real de estoque ainda não existe**:

- Storage continua em `produtos` (mesmo saldo para qualquer `empresaId` válido).
- A maior parte dos mutadores de saldo (**compra, venda, cancelamento, devolução, ajuste, reservas PDV**) ainda usa **SQL direto** sem `empresaId` e **fora** da porta.

**Resposta objetiva da Sprint:**

> Depois da Impl 01, os caminhos que ainda alteram estoque diretamente são principalmente: `compras.js`, `VendaPagamentoService`, `VendaDevolucaoService`, `ajusteEstoqueService`, `estoqueFiscalService.recalcularSaldosProduto`, reservas PDV/legado (`EstoqueReservaService` etc.) e pontos auxiliares (lotes/NF-e). A ordem mais segura para migrá-los à porta é: **ajuste → recalc → compra → devolução compra → cancel compra → devolução/cancel venda → baixa venda → reservas PDV**, sempre preservando a matemática F×NF.

**Veredito para Implementação 02:** **APTO** (com ordem e restrições desta auditoria).

---

## 2. Resultado da Implementação 01

| Critério | Status |
|---|---|
| Porta aceita empresa/contexto | ✅ |
| Reservas preparadas para empresa | ✅ |
| Motores F×NF não reescritos | ✅ |
| MTS = F↔NF mesmo produto | ✅ |
| Sem `estoque_empresa` / migration | ✅ |
| Sem fallback silencioso de empresa 1 / CNPJ config | ✅ |
| Isolamento físico por CNPJ | ❌ (ainda não — esperado) |
| Mutadores SQL migrados | ❌ (fora do escopo da 01) |

---

## 3. Arquivos alterados / criados (Impl 01)

### Alterados
| Arquivo | Δ (diff vs HEAD) |
|---|---|
| `estoqueSaldosPublico.js` | contrato + empresa |
| `reservasPublico.js` | contrato + `criarReservaNaoFiscal` |
| `index.js` | export contexto |
| `MtsService.js` | propaga `empresaId` |
| `MotorComercialService.js` | opts porta + COMPAT |
| `tests/mts/mts-v1.test.js` | `empresaId` + schema `reservado_*` |

### Criados
| Arquivo |
|---|
| `empresaContexto.js` |
| `tests/estoque/porta-publica-saldos-multiempresa.test.js` |
| `docs/arquitetura/PORTA_PUBLICA_SALDOS_MULTIEMPRESA.md` |

Diff agregado observado: **~+575 / −75** nas 6 peças versionadas + 3 untracked.

---

## 4. Análise do diff

| Arquivo | Motivo | Impacto | Risco | Escopo? |
|---|---|---|---|---|
| `empresaContexto.js` | Novo resolver | Fundação contrato | Médio (aceita ID sem tabela `empresas`) | Sim |
| `estoqueSaldosPublico.js` | Exigir contexto | Breaking sem empresa/COMPAT | Baixo se consumidores adaptados | Sim |
| `reservasPublico.js` | Idem + reserva NF | Pedido/reserva | Médio (NF sem tracking pedido) | Sim |
| `index.js` | Fachada única | Export | Baixo | Sim |
| `MtsService.js` | Passar empresa | MTS via porta | Baixo | Sim (mínimo) |
| `MotorComercialService.js` | COMPAT + propaga | Pedido certificado | Médio (COMPAT amplo) | Sim (mínimo) |
| Testes MTS / novos | Homologação | Regressão | Baixo | Sim |

**Alteração fora do escopo?** Não encontrada nos motores proibidos (distribuidor, MIDP, MPFC, venda/cancel/devolução SQL, MUC, MIIP, Central, TEF).

---

## 5. empresaContexto

### Coerência
Código **coerente** com o vocabulário CDS (`empresaId` / `empresa_id` / `empresa`), alinhado a `VendaContext` e FeatureFlags (não cria `companyId`/`tenant` paralelo).

### Perguntas

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Coerente? | **Sim** |
| 2 | Risco empresaId inválido? | **Baixo** — rejeita ≤0 / não inteiro |
| 3 | Risco empresa inexistente? | **Sim (transicional)** — sem tabela `empresas`, qualquer inteiro >0 é aceito |
| 4 | Fallback silencioso? | **Não** — exige empresa ou `modoLegadoSemEmpresa` explícito |
| 5 | Fallback empresa 1? | **Não** |
| 6 | Fallback CNPJ config? | **Não** |
| 7 | Conflito VendaContext? | **Não** — mesmo naming; VendaContext ainda não alimenta a porta |
| 8 | Conflito FeatureFlags? | **Não** |
| 9 | Outra impl de contexto? | Hooks esparsos (`req.user.empresa_id` nunca no JWT); **não** há segundo motor de tenant |

### Classificação das chamadas

| Local | Tipo | Classe |
|---|---|---|
| `estoqueSaldosPublico` → `resolverContextoEmpresa` | Porta | **A** |
| `reservasPublico` → idem | Porta | **A** |
| `MtsService` → `resolverEmpresaId` + exige ou legado | Consumidor | **A** (com empresa) / **B** se legado |
| `MotorComercial.optsPortaSaldos` → COMPAT se sem empresa | Consumidor | **B** (necessário hoje) · risco permanência **C** se esquecer remover |

---

## 6. estoqueSaldosPublico

| Método | empresaId | Validação | Storage | Observação |
|---|---|---|---|---|
| `consultarSaldo` | Obrigatório* | Sim | `produtos` | Retorno enriquecido (reservado/disponível) |
| `debitarSaldo` / `creditarSaldo` | Obrigatório* | Sim | `produtos` | Invariante SF+SNF |
| `transferirSaldoEntreTipos` | Obrigatório* | Sim | `produtos` | F↔NF mesmo produto+empresa |

\*ou `modoLegadoSemEmpresa: true`.

**Limitação crítica:** `empresaId` é validado/registrado, mas **não muda a linha lida/escrita** — falso isolamento até `estoque_empresa`.

---

## 7. reservasPublico

| Método | empresaId | Propagado | Mesmo contexto saldo? |
|---|---|---|---|
| `consultarDisponibilidade` | Sim* | No retorno | Sim (mesmos campos produto) |
| `consultarDisponibilidadeParaPedido` | Via opts | Sim | Sim |
| `criarReservaFiscal` | Sim* | Sim | Sim (`reservado_fiscal`) |
| `criarReservaNaoFiscal` | Sim* | Sim | Sim (`reservado_nao_fiscal`); **sem** linha em `pedido_estoque_reservas` |
| `liberarReservasPedido` | Exige contexto* | Parcial | Libera só tracking fiscal |

---

## 8. COMPAT_CERTIFICADA_PRE_MULTIEMPRESA

| Arquivo | Uso | Motivo | Classificação |
|---|---|---|---|
| `empresaContexto.js` | Define constante | Flag explícita | Necessária |
| `MotorComercialService.js` | `optsPortaSaldos` quando sem empresa | Pedido ainda sem `empresa_id` | **Necessária** · risco permanência **Alto** |
| `MtsService.js` | Aceita se deps/params setarem legado | Bridge | Necessária se chamado sem empresa |
| Testes porta | Cobre legado | Homologação | OK |
| Docs | Documenta | — | OK |

**Não** é fallback geral: sem flag e sem `empresaId` → `EMPRESA_OBRIGATORIA`.

**Risco:** Motor Comercial aplica COMPAT automaticamente na ausência de empresa — correto hoje, perigoso se novos módulos copiarem o padrão sem prazo de remoção.

---

## 9. SQL direto encontrado (saldos / reservas)

### Via porta (autorizado)
- `estoqueSaldosPublico._ajustarSaldo`
- `reservasPublico` (reservado_* )

### Fora da porta (mutadores a migrar)

| Arquivo | Método ~linha | Campos | Categoria | Porta? | Empresa? | Risco |
|---|---|---|---|---|---|---|
| `rotas/compras.js` | crédito ~685 | SF/SNF/EA | A Compra | Não | Não | **CRÍTICO** |
| `rotas/compras.js` | devolução ~913 | SF/SNF/EA | D Devolução | Não | Não | **CRÍTICO** |
| `rotas/compras.js` | cancel ~1742 | SF/SNF/EA | C Cancelamento | Não | Não | **CRÍTICO** |
| `VendaPagamentoService.js` | `atualizarSaldoProdutoAposBaixa` ~111 | SF ou SNF + EA | B Venda | Não | Não | **CRÍTICO** |
| `VendaDevolucaoService.js` | `devolverSaldosDistribuidos` ~20 | SF/SNF/EA | C/D | Não | Não | **CRÍTICO** |
| `estoqueNfeDevolucaoVenda.js` | reverter ~127 | SF/EA | D | Não | Não | **ALTO** |
| `ajusteEstoqueService.js` | ~114 | SF/SNF/EA | E Ajuste | Não | Não | **ALTO** |
| `rotas/produtos.js` | saldos iniciais ~2697 | SF/SNF/EA | E | Não | Não | **ALTO** |
| `estoqueFiscalService.js` | recalc ~218 | SF/SNF/EA | K Outros | Não | Não | **ALTO** |
| `lotesService.js` | `atualizarEstoqueConsolidado` ~356 | EA | K | Não | Não | **MÉDIO** |
| `EstoqueReservaService.js` | reservar/liberar | reservado_* | I Reserva | Não | Não | **ALTO** |
| `EstoqueConsumoReserva.js` | consumir | reservado_* | I | Não | Não | **ALTO** |
| `pedidoReservaPonteNucleo.js` | consumir | reservado_f | I | Não | Não | **ALTO** |
| `ReservaRepairService.js` | vários | reservado_f | I | Não | Não | **MÉDIO** |
| Cert harness | ReleaseCertification | SF/EA | K | Não | Não | **BAIXO** |

**Inventário / Perda / Produção dedicados:** **não existem** como módulos (perda/inventário = ajuste genérico).

---

## 10. Mutadores por categoria

| Cat | Situação |
|---|---|
| A Compra | SQL direto |
| B Venda | SQL direto (após distribuição) |
| C Cancelamento | SQL direto (via devolução saldos) |
| D Devolução | SQL direto |
| E Ajuste | SQL direto |
| F Inventário | Ausente |
| G Perda | Ausente (ajuste) |
| H Produção | Ausente |
| I Reserva | Porta (pedido) **e** SQL paralelo (PDV/legado) |
| J Transferência F↔NF | Porta via MTS |
| K Outros | recalc, lotes, cert |

---

## 11–19. Fluxos

### Compra
NF-e/Central → `POST /api/compras` → SQL `UPDATE produtos` (+SF/+SNF).  
**Porta?** Não. **Empresa?** Não. Futuro: CNPJ destinatário → `empresaId` → `creditarSaldo`. Risco migração: **Alto** (custo/MUC acoplados).

### Venda
Distribuidor (inalterado) → `reduzirEstoqueDistribuido` → SQL direto.  
**Porta?** Não. **Empresa?** Não (só terminal/caixa).

### Cancelamento / Devolução venda
`VendaCancelamentoService` → `devolverSaldosDistribuidos` SQL.  
**Porta?** Não.

### Ajuste
`ajusteEstoqueService` SQL. **Porta?** Não.

### Inventário / Perda / Produção
**Não existem** módulos dedicados.

### Reserva
- Pedido: `reservasPublico` (**porta**, com COMPAT no Comercial)
- PDV/entrega: `EstoqueReservaService` (**SQL direto**)

---

## 20–21. Motor Fiscal / Não Fiscal

**Arquivos do núcleo de regra alterados na Impl 01?**

| Componente | Alterado? |
|---|---|
| `distribuidorEstoqueVenda.js` | **NÃO** |
| MIDP / MPFC | **NÃO** |
| `estoqueFiscalService` (regras split) | **NÃO** (recalc SQL permanece legado) |
| `VendaPagamentoService` / Cancel / Devolução | **NÃO** |
| Porta saldos/reservas | **SIM** (contrato, não regra de distribuição) |

A matemática F×NF de venda permanece no distribuidor; a porta só debita/credita tipos já decididos.

---

## 22. MTS

Confirmado: **Fiscal ↔ Não Fiscal do mesmo `produtoId`**.  
`empresaId` é contexto da porta. **Não** há Empresa A → Empresa B.

---

## 23. Distribuidor

`distribuidorEstoqueVenda.js` **sem** referências a `empresaId` / porta.  
Smoke pós-Impl: `distribuirQuantidadeVenda(10,7,5,true)` → qF=7, qNf=3 — semanticamente igual.

---

## 24. Financeiro

`valor_fiscal` / `valor_nao_fiscal` continuam da distribuição da venda (MIDP/MPFC).  
Impl 01 **não** introduziu recálculo a partir de `produtos.saldo_*` no pagamento.

---

## 25–28. Isolamento de componentes

| Componente | Alterado indevidamente? | Nota |
|---|---|---|
| MUC RC2.1 | **NÃO** | Sem `empresaId` |
| MIIP | **NÃO** | Produto global |
| Central | **NÃO** | Continua → compras SQL |
| TEF | **NÃO** | Sem saldo |

---

## 29. Testes executados (pós-auditoria)

| Suite | Resultado |
|---|---|
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| Distribuidor smoke | **OK** (sessão anterior) |
| `rc80y-controla-estoque` | **OK** (sessão anterior) |

Suíte geral completa de vendas/NFC-e **não** foi reexecutada integralmente nesta auditoria; o diff não toca esses serviços.

---

## 30. Documentação vs código

`docs/arquitetura/PORTA_PUBLICA_SALDOS_MULTIEMPRESA.md` **corresponde** ao código nos pontos principais (contrato, COMPAT, invariantes, storage em `produtos`, logs via `CDS_LOG_SALDOS=1`).

Nuances (não corrigidas):

1. Docs enfatizam “empresa obrigatória”; na prática Comercial injeta COMPAT — **documentado**, mas fácil de subestimar.
2. `criarReservaNaoFiscal` sem persistência em `pedido_estoque_reservas` — docs mencionam limitação de storage, mas o detalhe do tracking pode ficar mais explícito.

**DOCUMENTAÇÃO ≈ IMPLEMENTAÇÃO** (sem divergência bloqueante).

---

## 31. Novo caminho × caminho antigo

| Fluxo | Porta Pública | SQL Direto | EmpresaId | Situação | Risco |
|---|---|---|---|---|---|
| Compra | Não | Sim | Não | Antigo | Crítico |
| Venda | Não | Sim | Não | Antigo | Crítico |
| Cancelamento venda | Não | Sim | Não | Antigo | Crítico |
| Devolução venda | Não | Sim | Não | Antigo | Crítico |
| Devolução/cancel compra | Não | Sim | Não | Antigo | Crítico |
| Ajuste | Não | Sim | Não | Antigo | Alto |
| Inventário | — | — | — | Ausente | — |
| Perda | — | — | — | Ausente | — |
| Produção | — | — | — | Ausente | — |
| Reserva pedido | Sim | (via porta) | COMPAT/opt | Novo+legado | Médio |
| Reserva PDV | Não | Sim | Não | Antigo | Alto |
| Transferência F↔NF (MTS) | Sim | Não (fora porta) | Sim/COMPAT | Novo | Baixo |

---

## 32. Mapa de migração futura (ordem recomendada)

1. **Ajuste estoque** (`ajusteEstoqueService` + saldos iniciais) — menor acoplamento fiscal de venda  
2. **`recalcularSaldosProduto`** — alinhar rebuild à porta (cuidado: omissões históricas)  
3. **Compra crédito** — entrada mais controlada + testes compras/MUC  
4. **Devolução/cancel compra**  
5. **Devolução/cancel venda** (`VendaDevolucaoService`)  
6. **Baixa venda** (`VendaPagamentoService`) — maior risco de regressão PDV/NFC-e  
7. **Reservas PDV** (`EstoqueReservaService` / consumo / ponte / repair) → unificar com `reservasPublico`  
8. **NF-e devolução assimetrias** (`estoqueNfeDevolucaoVenda`)  
9. **Lotes `estoque_atual`** — sincronizar invariante  
10. Remover **COMPAT** após `empresas` + JWT  

Critérios: menor risco → dependências → criticidade → testes → impacto fiscal.

---

## 33. Riscos críticos

1. **Ilusão de isolamento:** porta exige `empresaId` mas escreve o mesmo registro de `produtos`.  
2. **Dupla via:** porta (MTS/pedido) vs SQL (venda/compra) — possível divergência operacional quando multiempresa for ligado.  
3. **COMPAT no Motor Comercial** aplicado sempre que falta empresa — risco de cópia indevida.  
4. **Sem tabela `empresas`:** IDs positivos “fantasma” aceitos.  
5. Mutadores sem empresa continuam 100% do PDV/compras.  
6. `recalcularSaldosProduto` / lotes podem dessincronizar EA vs SF+SNF.  
7. Reserva NF sem tracking de pedido.

---

## 34. Recomendação

- **Não** criar `estoque_empresa` ainda.  
- Autorizar **Implementação 02** = redirecionar mutadores SQL → porta, **na ordem da §32**, começando por ajuste.  
- Em paralelo (ou antes da migração de venda): cadastro `empresas` + JWT para acabar com COMPAT no Comercial.  
- Preservar distribuidor/MIDP/MPFC intocados; a baixa só troca o *acesso* ao saldo.

---

## 35. APTO / NÃO APTO para Implementação 02

# APTO

**Justificativa:** contrato da porta está estável, testes 01/MTS/Comercial passam, motores preservados, e o mapa de SQL direto está completo o bastante para migrar com segurança incremental.

**Pré-condições da 02:**

1. Migrar **um** mutador por vez com testes focados.  
2. Exigir `empresaId` real **ou** COMPAT documentado — nunca inventar.  
3. Não mover storage nesta sprint.  
4. Não alterar algoritmo do distribuidor.

---

## 36. Tabela executiva

| Componente | Estado Atual | Usa Porta? | SQL Direto? | Tem EmpresaId? | Risco | Próxima Ação |
|---|---|---|---|---|---|---|
| Compra | Dual-ledger legado | Não | Sim | Não | Crítico | Migrar crédito/cancel/dev |
| Venda | Distribuidor + SQL | Não | Sim | Não | Crítico | Migrar baixa (após ajuste/compra) |
| Cancelamento | Via devolução SQL | Não | Sim | Não | Crítico | Migrar com devolução |
| Devolução | SQL | Não | Sim | Não | Crítico | Migrar |
| Ajuste | SQL | Não | Sim | Não | Alto | **1º candidato Impl 02** |
| Inventário | Ausente | — | — | — | — | Fora |
| Perda | Ausente | — | — | — | — | Fora |
| Produção | Ausente | — | — | — | — | Fora |
| Reserva pedido | Porta + COMPAT | Sim | Via porta | COMPAT | Médio | Remover COMPAT c/ empresas |
| Reserva PDV | Legado | Não | Sim | Não | Alto | Unificar |
| MTS | Porta | Sim | Não* | Sim/COMPAT | Baixo | Manter |
| Motor Fiscal (distrib.) | Intact | N/A | Não | Não | — | Preservar |
| Motor Não Fiscal | Intact | N/A | Não | Não | — | Preservar |
| Financeiro | Intact | Não | Não (valores) | Não | Baixo | Preservar |
| MUC | Intact | Não | Não | Não | — | Preservar |
| MIIP | Intact | Não | Não | Não | — | Preservar |
| Central | Intact | Não | Indireto via compra | Não | Médio | Depois compras |
| TEF | Intact | Não | Não | N/A | — | Preservar |
| Relatórios | Global | Não | SELECT | Não | Médio | Pós-estoque_empresa |
| Dashboard | Global | Não | SELECT | Não | Médio | Pós-estoque_empresa |

\*MTS não faz SQL próprio em `produtos`; a porta faz o UPDATE.

---

## 37. Confirmações finais

- Nenhuma alteração foi feita nesta auditoria.  
- Nenhuma migration / `estoque_empresa` / cadastro empresa criado aqui.  
- Nenhuma correção aplicada aos riscos apontados.
