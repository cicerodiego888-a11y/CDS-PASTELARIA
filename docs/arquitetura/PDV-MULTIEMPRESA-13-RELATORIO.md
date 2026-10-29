# PDV-MULTIEMPRESA-13 — Diagnóstico da consulta de estoque entre empresas

**Data:** 2026-10-26  
**Tipo:** auditoria técnica + testes sintéticos (sem alteração de regras de produção)  
**Estado final:** **CONCLUÍDA**

## 1. Objetivo

Explicar, com evidências, por que o PDV pode informar saldo insuficiente (ex.: Refrigerante Copo 300 ml) mesmo quando o operador “vê” estoque em alguma empresa — e indicar a menor correção candidata **sem implementá-la**.

## 2. Origem real do saldo consultado pelo seletor

| Etapa | Componente | Fonte |
|---|---|---|
| Preview / finalização | `POST /api/vendas/selecao-empresa` → `SelecaoEmpresaVendaPdvService` | Resolve `tipoSaldo` da operação |
| Capacidade | `ServicoCapacidadeCarrinhoEmpresa.avaliarCapacidadeCarrinho` | Avalia **cada** empresa ativa elegível |
| Disponibilidade | `reservasPublico.consultarDisponibilidade(produtoId, { empresaId })` | Com `empresaId`: **`estoque_empresa`** |
| Sem registro EE | `EstoqueEmpresaService.consultarSaldoParaEmpresa` → `null` | Porta devolve **zeros** (sem fallback para `produtos.*`) |
| Produto sem ficha | `lerDisponivel(disp, tipoSaldo)` | **Somente** bucket `FISCAL` ou `NAO_FISCAL` da operação |
| Produto com ficha | `lerDisponivelFichaInsumo` nos **insumos** | Total `disponivel_fiscal + disponivel_nao_fiscal` **por empresa** |

**Fato comprovado (teste sintético):** `produtos.saldo_*` / `estoque_atual` globais **não** alimentam a capacidade multiempresa. Valores altos em `produtos` com EE ausente ou zerado → disponibilidade elegível **0**.

Não há cache de saldo na capacidade: cada avaliação relê `estoque_empresa`. O `hashCarrinho` só fingerprinta o carrinho.

## 3. Empresas e IDs que participam

1. Lista: `empresas` com `COALESCE(ativo,1)=1`, ordenadas por `id`.
2. Matriz: CNPJ `0001` (`escolherMatrizPadrao`) — obrigatória; sem ela → `MATRIZ_AUSENTE` (não é “estoque zero”).
3. Ordem de avaliação: **matriz primeiro**, depois demais IDs crescentes.
4. Filtro opcional: `UsuarioEmpresaService.listarEmpresasPermitidas` (usuário sem vínculo → empresa `SEM_ACESSO`).
5. Seleção: primeira empresa que `elegivel && atendeIntegralmente` (matriz preferida se capaz). **Não soma saldos entre CNPJs.**

Nos testes M13 (memória): Empresa A = matriz `…000181`, Empresa B = filial `…000262`. Em produção, usar IDs reais do cadastro do cliente (não acessados nesta sprint).

## 4. Consulta por produto × empresa × tipo de saldo

### 4.1 Preview PDV (`frontend/pdv/js/pdv.js`)

```json
{ "itens": [...], "emitir_fiscal": <pdvEmitirFiscalNaVenda>, "venda_fiscal": <mesmo>, "origem": "PDV" }
```

- `emitir_fiscal: false` (padrão sem emissão) → `tipoSaldo = NAO_FISCAL`.
- `emitir_fiscal: true` → `tipoSaldo = FISCAL` (+ `exigirFiscalValido`).

### 4.2 Gargalos típicos no produto sem ficha

| Código | Significado |
|---|---|
| `ESTOQUE_INSUFICIENTE_NAO_FISCAL` | Bucket NF insuficiente naquela empresa |
| `ESTOQUE_INSUFICIENTE_FISCAL` | Bucket F insuficiente |
| `INSUMO_INSUFICIENTE` | Ficha: total F+NF do insumo insuficiente (`baseConsulta: TOTAL_FICHA`) |

O campo `disponivel` no gargalo é o **saldo elegível do bucket**, não o `estoque_atual` total.

## 5. Evidências dos testes sintéticos

Suite: `tests/pdv/pdv-multiempresa-13-diagnostico-estoque.test.js`  
Comando: `node --test tests/pdv/pdv-multiempresa-13-diagnostico-estoque.test.js` → **9/9 pass**.

| # | Cenário | Resultado |
|---|---------|-----------|
| 1 | Consulta vs persistido; global `produtos` 999 vs EE | EE ausente → disp 0; EE B NF=7 → disp NF=7 |
| 2 | A sem saldo, B com NF suficiente | Seleciona **B**; A gargalo `disponivel: 0` NF |
| 3 | A fiscal / B NF | Fiscal→A; NF→B; total UI em A ≠ elegível NF |
| 4 | Uma empresa cobre todos os itens | Selecionada |
| 5 | Itens partidos entre CNPJs | `NENHUMA_EMPRESA_ATENDE` (sem soma) |
| 6 | Ficha + insumo insuficiente | Bloqueio por **insumo**; saldo do acabado ignorado |
| 7 | EE ausente ≡ EE com zero | Ambos disp F/NF = 0 |
| 8 | Preview `emitir_fiscal:false` + estoque **só fiscal** | `disponivel: 0` NF apesar de `saldo_fiscal=20` persistido |
| 9 | Mutação EE entre avaliações | Segunda leitura reflete zero (sem cache) |

## 6. Interface: total vs elegível

| Camada | O que mostra / valida |
|---|---|
| Catálogo / `validarEstoqueVenda` (modo não fiscal) | Usa **`saldoTotal = fiscal + nao_fiscal`** da empresa do contexto (`pdv.js`) |
| Motor F×NF / capacidade / seletor (M08 Opção A) | Bucket **exclusivo** da operação |
| Banner M12 | Mensagem curta; detalhe técnico só no `console.warn('[PDV][selecao-empresa]')` |

**Desalinhamento causal principal (comprovado sinteticamente):** o operador pode **adicionar** o item ao carrinho porque a UI local olha o **total**, enquanto `selecao-empresa` exige o bucket **não fiscal** (venda sem emissão) ou **fiscal** (com emissão). Estoque “visível” em `estoque_atual` / soma F+NF **não** implica `disponivel` elegível > 0.

Segundo desalinhamento comum: estoque cadastrado só em `produtos` (legado) ou só na empresa errada no header — a capacidade multiempresa **não** usa o legado global.

## 7. Insumos de ficha (separado)

- Capacidade **não** debita o SKU acabado quando `utiliza_ficha_tecnica`.
- Consome `montarLinhasConsumo` → agrega insumos → `consultarDisponibilidade(insumoId, empresaId)`.
- Elegibilidade do insumo: **soma F+NF na mesma empresa** (contrato ficha vigente; distinto do produto sem ficha pós-M08).
- Gargalo reporta `insumoId`, `necessario`, `disponivel`, `disponivel_fiscal`, `disponivel_nao_fiscal`.

## 8. Causa raiz confirmada (mecanismo)

A “disponibilidade zerada” no seletor **não** significa, por si só, ausência de estoque físico no grupo econômico. Significa:

> Em **nenhuma** empresa elegível o **bucket exigido pela operação** (ou o **total F+NF dos insumos**, se ficha) cobre **integralmente** o carrinho — avaliado **por CNPJ**, sem soma entre empresas.

Hipótese operacional mais frequente para refrigerantes **sem ficha** no PDV padrão (`emitir_fiscal: false`):

1. Saldo existe em `saldo_fiscal` (e/ou aparece no total da UI), **mas** `saldo_nao_fiscal` é 0 em todas as empresas → gargalos com `disponivel: 0` e `tipoSaldo: NAO_FISCAL` (teste #8).
2. Ou o saldo NF está em outra empresa, porém **outro item** do carrinho impede atendimento integral naquela empresa (teste #5).
3. Ou não há linha em `estoque_empresa` para o produto×empresa (teste #1/#7), apesar de números em `produtos`.

**Não comprovado nesta sprint (exige Network + DB do cliente):** IDs reais do Refrigerante 300 ml, distribuição F/NF por empresa no banco oficial, e o `code`/gargalos da sessão Electron observada. Banco oficial **não** foi acessado (restrição).

## 9. Dados ainda necessários (campo)

Capturar **uma** resposta 409 de `POST /api/vendas/selecao-empresa`:

1. Body: `itens[]`, `emitir_fiscal`, `venda_fiscal`.
2. JSON: `code`, `selecao.tipoSaldo`, `selecao.capacidade.matrizId`, `porEmpresa[].empresaId` + `gargalos` (`disponivel`, `tipoSaldo`, `codigoMotivo`, `insumoId`).
3. Para o `produto_id` do gargalo: dump de `estoque_empresa` (F/NF/reservado) **por empresa** (sem SEFAZ / sem venda).

## 10. Menor correção necessária (próxima sprint — **não implementar agora**)

Ordenada por evidência; escolher **uma** após o Network:

| Prioridade | Se evidência mostrar | Menor ação |
|---|---|---|
| **P0 UX** | UI total permite carrinho; capacidade NF/F bloqueia com estoque no outro bucket | Alinhar `validarEstoqueVenda` / exibição ao **mesmo bucket** da operação (espelho M08), sem liberar venda cruzada |
| **P0 dados** | EE ausente ou NF=0 com F>0 e venda não fiscal | Ajuste operacional: popular `estoque_empresa` / bucket correto — **não** mudar motor |
| **P1 mensagem** | Gargalos ricos no JSON, banner pobre | Expor `tipoSaldo` + `disponivel` elegível no banner/console já usados (M12) |
| **Evitar** | — | Somar CNPJs; transferir estoque automático; usar total F+NF no produto sem ficha; remover 409; tocar F×NF/ficha/seletor além do alinhamento UX |

**Não recomendado nesta linha:** “liberar venda” para sumir o erro.

## 11. Arquivos

### Inspecionados

- `backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa.js`
- `backend/motores/muv/capacidade/selecionarEmpresaCapacidade.js`
- `backend/services/vendas/SelecaoEmpresaVendaPdvService.js`
- `backend/services/fiscalNaoFiscal/reservasPublico.js` (`consultarDisponibilidade`)
- `backend/services/estoque/EstoqueEmpresaService.js`
- `frontend/pdv/js/pdv.js` (`atualizarSelecaoEmpresaPdv`, `validarEstoqueVenda`)
- Relatórios M04/M08/M12/SEL-03 (contexto)

### Criados nesta sprint

- `tests/pdv/pdv-multiempresa-13-diagnostico-estoque.test.js`
- `docs/arquitetura/PDV-MULTIEMPRESA-13-RELATORIO.md` (este arquivo)

### Alterados em produção

**Nenhum.** Motor F×NF, ficha, seletor, saldos e PDV Universal intactos.

## 12. Encerramento

| Item | Valor |
|---|---|
| Estado | **CONCLUÍDA** |
| Origem do saldo do seletor | `estoque_empresa` via `consultarDisponibilidade` + bucket da operação |
| Por que “aparece zerado” | `disponivel` do **bucket elegível** (ou insumo), não o total UI / não a soma entre CNPJs |
| Menor correção | UX alinhada ao bucket **ou** correção de dados EE — ver §10; **sem implementar aqui** |
| Testes | 9/9 sintéticos verdes |

**Não implementar correção sem nova autorização.**
