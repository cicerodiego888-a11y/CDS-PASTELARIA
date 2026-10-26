# AUD-MUV-01 — Auditoria de seleção automática da empresa responsável pela venda

**Tipo:** auditoria analítica, somente leitura  
**Data:** 2026-10-26  
**Projeto:** CDS Sistemas — PDV e Motor Universal de Vendas (MUV)  
**Homologação:** pendente (Tech Lead)

## 1. Resumo executivo e veredito

**Veredito:** a regra de negócio do Product Owner — *seleção automática de uma única empresa capaz de atender integralmente o pedido (matriz prioritária, estoque + ficha técnica, sem divisão silenciosa, NFC-e de um só CNPJ)* — **não está implementada** no PDV oficial.

O que o código comprova hoje:

| Aspecto | Situação no PDV oficial (`/pdv`) |
|---|---|
| Empresa da venda | Escolhida pelo **contexto operacional** (`CdsEmpresaContexto` / `X-Empresa-Id`), não por algoritmo de capacidade do carrinho |
| Unidade da venda | Uma venda → um `vendas.empresa_id` (caminho convencional via `VendaPagamentoService`) |
| Estoque / ficha | Debitados **depois** da empresa já definida; ficha não escolhe a empresa |
| Política matriz → filiais por capacidade do pedido | **Ausente** |
| Impedir divisão do pedido entre CNPJs por falta de estoque | No PDV oficial a divisão por item **não ocorre** (empresa única do contexto); também **não há** avaliação automática de “outra empresa que atenda o pedido inteiro” |

O **PDV Universal** (`/pdv-universal`) e o **MUV** (`AtendimentoMultiempresaService`) implementam atendimento **multiempresa por item/operação** (agrupamento `agruparItensPorEmpresa`, rateios, possível `FISCAL_PARCIAL`). Isso é **outro modelo**: não substitui a regra do PO e **não** deve ser tratado como o PDV oficial apenas por ter recursos multiempresa.

**Confiança:** alta para ausência da seleção automática no PDV oficial (evidência direta de código e documentação 03.01). Média para detalhes de concorrência em todos os caminhos (há reservas no MUV/público; o PDV Normal depende do núcleo de venda/estoque no momento da persistência).

## 2. PDV oficial vs Universal

| Critério | Evidência |
|---|---|
| Menu ERP | `frontend/erp/index.html` → `#nav-abrir-pdv` → `href="/pdv"` |
| Contrato de acesso | `frontend/shared/js/pdv-acesso-oficial.js`: `/pdv` = **PDV Normal (oficial em evolução)**; `/pdv-universal` = **congelado (legado)** |
| Arquitetura Bloco 3 | `docs/arquitetura/PDV_NORMAL_MULTIEMPRESA_PASTELARIA_03_01.md`: PDV Normal é o único em evolução; Universal não deve basear a implementação |
| Mapa de execução | `docs/arquitetura/MAPA_REAL_PDV_LEGADO.md`: HTML `frontend/pdv/index.html`, motor `pdv.js` |

**Conclusão de escopo desta auditoria:** fluxo oficial = **PDV Normal `/pdv`**. Universal/MUV são citados apenas para contrastar e evitar falsa equivalência.

## 3. Arquivos, classes, funções e endpoints relevantes

### PDV oficial
- `frontend/pdv/js/pdv.js` — `enviarVenda` → `POST ${API_URL}/vendas` + `CdsEmpresaContexto.anexarHeaderXhr`
- `frontend/shared/js/cds-empresa-contexto.js` — seleção/persistência de empresa e `X-Empresa-Id`
- `backend/services/vendas/VendaApplicationService.js` — porta `criarVenda`; em MULTIEMPRESA e EMPRESA_UNICA **conclui** via `VendaPagamentoService` (não chama `criarAtendimento` no POST `/api/vendas`)
- `backend/services/vendas/VendaPagamentoService.js` — `exigirEmpresaDaOperacao(req)`, persiste `vendas.empresa_id`, estoque e `consumirFichaTecnicaDaVendaCb`
- `backend/services/produtos/FichaTecnicaConsumoService.js` — baixa insumos na **empresa já resolvida** da venda

### MUV / Universal (não oficial para esta regra)
- `backend/motores/muv/AtendimentoMultiempresaService.js` — `criarAtendimento`, reserva, pagamento, materialização
- `backend/motores/muv/contratos.js` — `agruparItensPorEmpresa`, rateios, distribuição
- `backend/motores/muv/FiscalizarAtendimentoService.js` — fiscalização por operação/empresa (pode ser parcial)
- `frontend/pdv-universal/pdv-universal-cart.js` — item com `empresa_id` obrigatório; chave `produtoId:empresaId`
- `POST /api/pdv-universal/checkout` (doc 05.06)

### Estoque / disponibilidade
- `backend/services/fiscalNaoFiscal/reservasPublico.js` — `consultarDisponibilidade` / reservas com `empresaId` → `estoque_empresa`
- `backend/services/estoque/estoqueEmpresaSchema.js` — saldo por empresa

### Matriz (outro domínio)
- Contexto de matriz padrão aparece em fluxos de **Central / fiscal** (ex.: testes `tests/central-entradas/contexto-empresa-operacional.test.js`), **não** como seletor automático de capacidade do carrinho do PDV.

## 4. Fluxo real do PDV oficial (carrinho → venda persistida)

```
Operador abre /pdv
  → CdsEmpresaContexto (empresa selecionada / matriz padrão do seletor, se houver)
  → Monta carrinho em memória (pdv.js) — itens sem empresa por linha
  → Finalizar → enviarVenda(payload)
  → POST /api/vendas + Authorization + X-Empresa-Id
  → VendaApplicationService.criarVenda
       → EMPRESA_UNICA | MULTIEMPRESA → VendaPagamentoService.criarVenda
  → exigirEmpresaDaOperacao(req) → empresaIdVenda
  → Persiste venda/itens/pagamentos/financeiro com empresa_id
  → Debita estoque / consome ficha técnica nessa empresa
  → Resposta com venda_id; fiscal pós-pagamento usa a empresa da venda
```

**Não há** etapa “avaliar empresas candidatas pelo estoque+ficha do carrinho inteiro” antes do POST.

Documento 03.01 (atenção operacional): com MULTIEMPRESA global, o despacho MUV no POST `/api/vendas` foi alinhado para **não** materializar atendimento no lugar da venda; a conclusão oficial permanece o núcleo de pagamento. Evidência: `concluirVendaNoNucleoOficial` compartilhado pelos dois modos; `executarAtendimentoMultiempresa` marcado como fora do POST `/api/vendas` (MUV / Universal / testes).

## 5. Algoritmo de seleção empresarial

| Pergunta | Achado |
|---|---|
| Existe algoritmo de escolha automática por capacidade do pedido no PDV oficial? | **Não** (não comprovado / ausente no fluxo `/pdv` → `/api/vendas`) |
| Matriz tem prioridade efetiva na venda? | Apenas indireta: pode ser a empresa **já selecionada** no seletor (padrão operacional do contexto). **Não** há ranking matriz → filiais por “atende o pedido” |
| Critérios de desempate entre filiais por estoque/ficha? | **Ausentes** no PDV oficial |
| Escolha automática ou operador? | **Operador / contexto** (`X-Empresa-Id`) |
| Decisão pela venda inteira ou por item? | PDV oficial: **venda inteira** sob uma empresa de contexto. Universal/MUV: **por item → várias operações** |

No MUV, `agruparItensPorEmpresa` **pressupõe** `empresaId` já no item e **gera N operações**. Isso **permite** (por desenho) um atendimento com várias empresas — incompatível com a regra do PO de “uma venda / uma empresa / uma NFC-e”, se usado como caminho de venda fragmentada.

## 6. Estoque e ficha técnica

### Disponibilidade por empresa
- `consultarDisponibilidade(produtoId, { empresaId })` em `reservasPublico` lê saldo empresarial (`estoque_empresa`), com distinção fiscal / não fiscal.
- Usada na validação/reserva do **atendimento MUV** e em consultas de disponibilidade do Universal.
- No PDV oficial, a checagem crítica de estoque+ficha ocorre no **consumo** atrelado à empresa da venda, não como motor de seleção prévia do CNPJ.

### Ficha técnica
- Cadastro/consulta: rotas `ficha-tecnica` em `produtos.js`; consumo: `FichaTecnicaConsumoService.consumirFichaTecnicaDaVenda`.
- Agrega insumos e debita **na `empresaId` passada** (da venda).
- **Não** há função evidenciada do tipo “quantas unidades completas a empresa X consegue produzir deste SKU com a ficha”, usada para escolher a empresa do carrinho.

### Reserva / concorrência
- MUV: reserva atômica por operação (`AtendimentoMultiempresaService` + `reservasPublico`) — caminho Universal/atendimento.
- PDV oficial: persistência transacional da venda + débito; detalhe fino de corrida sob carga **não comprovado** nesta auditoria como suite E2E dedicada à seleção multiempresa (porque a seleção automática não existe).

## 7. Ciclo completo e vínculo único

No **PDV oficial**, uma vez definida a empresa do contexto:

1. Carrinho — sem empresa por item.  
2. Escolha automática por capacidade — **ausente**.  
3. Reserva prévia multiempresa — **não** no fluxo padrão do `/pdv`.  
4–8. Pagamento, materialização, estoque, caixa/financeiro, fiscal — ancorados em `vendas.empresa_id` / `exigirEmpresaDaOperacao` (evidência em `VendaPagamentoService`).  
9. Falhas — rollback no núcleo de venda (caminhos específicos MUV têm cancelamento/reserva próprios).

Risco de “voltar ao fluxo convencional”: o POST `/api/vendas` **já é** o fluxo convencional de empresa única do contexto. O MUV não é o finalizador oficial desse POST (03.02 / comentários do `VendaApplicationService`).

**NFC-e / CNPJ:** no caminho oficial, fiscalização pós-venda usa a empresa da venda. Divisão de NFC-e entre CNPJs **não** aparece no PDV Normal. No MUV, fiscalização por operação admite cenários parciais (`FISCAL_PARCIAL`) — relevante só se o atendimento multiempresa for usado como venda.

## 8. Matriz de cenários (analítica)

Exemplos fictícios avaliados **só por inspeção**; sem vendas reais.

| Cenário | Status | Evidência |
|---|---|---|
| 1 — Matriz suficiente → selecionar matriz automaticamente | **Ausente** no PDV oficial | Não há avaliador de capacidade do pedido; depende do contexto já selecionado |
| 2 — Matriz insuficiente → única filial que atende | **Ausente** | Sem política determinística de failover de empresa no `/pdv` |
| 3 — Soma agregada ok, nenhuma empresa atende sozinha → bloquear divisão | **Parcial / por acidente de desenho** | PDV oficial não divide itens entre empresas; também **não** redireciona para outra empresa. Se o estoque da empresa do contexto for insuficiente, espera-se falha de estoque/ficha — **não** “juntar” filiais. Universal/MUV **pode** distribuir itens (oposto do desejado) |
| 4 — Ficha: disponibilidade por empresa com todos os ingredientes | **Parcial** | Consumo/validação de ficha é **por empresa** no débito; **não** há cálculo de “unidades produzíveis” para seleção automática pré-venda |
| 5 — Concorrência | **Parcial / não comprovado E2E** | Reservas atômicas no MUV; PDV Normal depende do núcleo de venda — sem prova E2E nesta auditoria para o algoritmo inexistente |
| 6 — Integridade empresarial (venda→estoque→financeiro→fiscal) | **Implementado** no PDV oficial (empresa do contexto) | `empresa_id` na venda e nos serviços dependentes; NFC-e alinhada à venda. **Não** cobre seleção automática |

Legenda: implementado | parcial | ausente | não comprovado.

## 9. Testes existentes e limitações

| Área | Exemplos | O que comprovam | Limitação |
|---|---|---|---|
| PDV Universal / contexto | `tests/pdv-universal/*` | Contexto, UI, checkout MUV | Não são o PDV oficial; não provam seleção automática por ficha do carrinho |
| MUV atendimento | `tests/muv/atendimento-multiempresa-04-03.test.js` | Agrupamento por empresa, validação de estoque **por item.empresaId** | Pressupõe empresa já no item; permite multi-operação |
| Matriz padrão | `tests/central-entradas/contexto-empresa-operacional.test.js` | Matriz no contexto fiscal/central | Domínio Central, não PDV venda |
| Ficha / estoque pastelaria | docs/testes 03.x (ficha, estorno) | Consumo/estorno por empresa da venda | Pós-escolha da empresa |
| PDV Normal ownership | docs 03.01 + testes multiempresa de venda/caixa | Uma empresa por venda via header | Sem algoritmo de capacidade |

**Não afirmar** que o fluxo do PO está operacional só porque existem MUV, Universal, `estoque_empresa` ou testes de matriz na Central.

## 10. Lacunas (prioridade)

| ID | Prioridade | Lacuna |
|---|---|---|
| L1 | **P0** | Ausência de motor de **seleção automática de uma empresa** capaz de atender o **pedido inteiro** (estoque + ficha) no PDV oficial |
| L2 | **P0** | Ausência de política determinística documentada **matriz → filiais** para failover quando a matriz não atende |
| L3 | **P1** | Ficha técnica não expõe “capacidade produzível por empresa” reutilizável na seleção |
| L4 | **P1** | Risco de confusão operacional: Universal/MUV **permitem** multiempresa por item — conflita com a regra do PO se forem usados como venda |
| L5 | **P2** | Cobertura E2E inexistente para os cenários 1–5 do briefing no PDV `/pdv` |
| L6 | **P2** | Mensagens de UX quando a empresa do contexto não atende (sugerir troca? bloquear? — não especificado no código do PDV Normal além da falha de estoque) |

## 11. Proposta de correção (sprints futuras — **não iniciadas**)

1. **AUD/SPEC-MUV-02** — Especificar contrato da política (matriz primeiro; ordenação de filiais; empates; o que fazer se ninguém atende; exclusão explícita de split).  
2. **MUV-CAP-01** — Serviço somente leitura: para um carrinho, retornar por empresa `{ atende: bool, unidadesMax, gargalos[] }` usando `estoque_empresa` + ficha.  
3. **PDV-SEL-01** — No PDV oficial, **antes** de `POST /api/vendas`, chamar o serviço; fixar `X-Empresa-Id` / `empresa_id` da venda na empresa escolhida; **proibir** finalizar se nenhuma empresa atender.  
4. **PDV-SEL-02** — Testes `:memory:` dos cenários 1–4 + isolamentoência 5 + invariante NFC-e/empresa.  
5. **GOV-01** — Documentar que Universal/MUV multi-operação **não** substitui essa regra; alinhar produto (congelar ou restringir split).

Nenhuma dessas sprints foi iniciada nesta auditoria.

## 12. Confirmação de método

- Somente leitura em código/docs/testes.  
- Nenhum arquivo de produção, teste existente ou configuração foi modificado.  
- Nenhum banco oficial/cliente, venda real, SEFAZ, migração ou backfill.  
- Artefato único: este relatório `docs/auditorias/AUD-MUV-01-RELATORIO.md`.

**Status:** AUD-MUV-01 concluída. Aguardando homologação do Tech Lead. Sem sprint de implementação automática.
