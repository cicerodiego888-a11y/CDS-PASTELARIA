# PLANO DE REAPROVEITAMENTO — Vendas 05.38.G.A

**Classificação:** SOMENTE LEITURA — sem implementação  
**Objetivo:** orientar 05.38.G.B sem criar abstrações nesta auditoria

---

## JÁ EXISTE E REUTILIZAR

| Componente | Uso futuro sugerido |
|------------|---------------------|
| `ContratoOperacionalService` | EMPRESA_SIMPLES → empresa operacional na criação/consulta |
| `empresaContexto.js` / `criarMiddlewareContextoEmpresa` | Já em `rotas/vendas.js`; evoluir `obrigatorio` conforme modo |
| `FinanceiroEmpresaContextoService` | Já chamado em `VendaPagamentoService.criarVenda` (~resolverEmpresaIdParaFinanceiro) |
| `CaixaEmpresaContextoService` + `validarCaixaAberto.js` | Fronteira caixa×contexto (05.38.C); estender para venda |
| `debitoEstoqueVendaViaPorta` / `creditoEstoqueVendaViaPorta` | Porta oficial; exigir empresa em MULTI |
| `estoque_empresa` + `estoqueSaldosPublico` | Destino com `empresaId` |
| `PDVUniversalContextService` | Contexto operacional PDV Universal |
| `FiscalizarAtendimentoService` | Padrão correto: `emitirPorVendaId(id, { empresaId })` |
| `ComprasEmpresaContextoService` | **Referência de padrão** F.B (adaptador fino) — não copiar cegamente |
| `CdsEmpresaContexto` + header `X-Empresa-Id` | Frontend PDV/ERP |
| Writers W1/W2/W3 | Evoluir INSERT; **não** criar quarto writer |
| `EmpresaService` / vínculo usuário×empresa | Validação ativa |

---

## EXISTE MAS PRECISA CONECTAR

| Peça | Conexão faltante |
|------|------------------|
| `req.empresaId` resolvido | → coluna `vendas.empresa_id` no INSERT (W1, W2, W3) |
| `atendimento_operacoes.empresa_id` | → propagar para `vendas` na materialização W2 |
| `caixa_sessoes.empresa_id` | → validar coerência venda×sessão após coluna existir |
| `VendaFiscalService.emitirFiscalSeSolicitado` | → passar `empresaId` (mesmo de financeiro) ao emissor |
| Listagens `GET /api/vendas` | → filtro empresa (SIMPLES automático / MULTI contexto) |
| Cancel/devolver/GET/:id | → `exigirRegistroDaEmpresa` ou equivalente |
| Estorno cancelamento | → `financeiro.empresa_id` no INSERT estorno |
| W2 financeiro legado | → alinhar INSERT financeiro com `empresa_id` da operação |

---

## PRECISA CENTRALIZAR

| Tema | Recomendação |
|------|--------------|
| Resolução única “empresa da venda” | Ordem sugerida: operação MUV > caixa sessão > header > Contrato SIMPLES |
| Alinhar estoque, financeiro, fiscal | Mesma `empresa_id` **antes** do BEGIN e reutilizada |
| Evitar COMPAT legado em MULTI | `exigirEmpresa: true` em `montarOpcoesBaixaEstoqueVenda` quando MULTIEMPRESA |
| Fiscal | Um caminho: sempre `empresaId` explícito no emissor |

**Não criar** `VendaEmpresaContextoService` nesta auditoria.  
**Avaliação para G.B:** **provavelmente necessário** — espelhar `FinanceiroEmpresaContextoService` / `ComprasEmpresaContextoService` como adaptador fino (~50–80 linhas), não motor paralelo.

---

## DUPLICADO

| Item | Ação |
|------|------|
| Fiscal W1 (global) vs MUV (com empresa) | Unificar passagem de `empresaId` |
| Três INSERTs `vendas` | Manter; unificar **contrato** de colunas (incl. `empresa_id`) |
| Resoluções independentes pré-INSERT | Unificar entrada na gravação |

---

## AUSENTE (para 05.38.G.B)

1. Coluna `vendas.empresa_id` (+ índice + backfill seguro).  
2. Filtro listagem/relatório por empresa.  
3. Guard ownership GET/:id, cancelar, devolver, reimpressão.  
4. Propagação fiscal com `empresaId` obrigatório em MULTI.  
5. Estorno cancelamento com `empresa_id`.  
6. Testes G.B: venda A inacessível em contexto B; estoque/fiscal coerentes.

---

## Backfill seguro (somente planejamento)

| Fonte | Join | Confiabilidade |
|-------|------|----------------|
| `caixa_sessoes.empresa_id` | `vendas.caixa_sessao_id` | Alta se sessão preenchida |
| `atendimento_operacoes.empresa_id` | `venda_id` | Alta para MUV |
| `financeiro.empresa_id` | `venda_id` | Média — validar unicidade |
| `nfce_notas.empresa_id` | `venda_id` | Média — só vendas fiscais |
| Contrato SIMPLES | config operacional | Alta apenas SIMPLES |
| MULTI ambíguo | — | **Manter NULL** |

---

## Ordem sugerida (sem implementar agora)

1. Schema + backfill (SIMPLES seguro; MULTI sem inventar).  
2. Resolução única + INSERT W1/W2/W3 com `empresa_id`.  
3. Guardas leitura/cancel/devolver.  
4. Fiscal: `empresaId` obrigatório.  
5. Estoque MULTI: `exigirEmpresa`.  
6. Listagens e relatórios.  
7. Estorno cancelamento + pagamentos (se necessário).  
8. Testes + docs ESTADO B.

---

## Declaração

Nenhum serviço novo criado nesta sprint de auditoria.
