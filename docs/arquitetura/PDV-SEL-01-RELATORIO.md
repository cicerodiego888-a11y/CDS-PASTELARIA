# PDV-SEL-01 — Relatório: integração do seletor automático de empresa

**Data:** 2026-10-26  
**Pré-requisitos:** MUV-CAP-01, AUD/SPEC-MUV-02, HOTFIX-BUILD-01  
**Resultado final:** **APROVADA** (com limitações documentadas na §8)

## 1. Resumo da implementação

O PDV oficial (`/pdv` → `POST /api/vendas`), em modo `MULTIEMPRESA` e origem `PDV`, passa a:

1. Avaliar a capacidade do carrinho inteiro (estoque por empresa + ficha técnica) via `ServicoCapacidadeCarrinhoEmpresa`.
2. Selecionar automaticamente a empresa (matriz prioritária; filiais em `id ASC`).
3. Fixar `req.empresaId` / header efetivo **no servidor**, sem permitir que `X-Empresa-Id` ou `body.empresa_id` sobrescrevam a decisão.
4. Revalidar na finalização (consulta ≠ reserva); bloquear com mensagem clara se ninguém atender, matriz ausente/ambígua, caixa incompatível ou tipo de saldo indeterminado.
5. Exibir no PDV um banner **informativo** da empresa selecionada (R06), sem troca por item.

`EMPRESA_SIMPLES` / `EMPRESA_UNICA` permanece no fluxo anterior (R11). PDV Universal **não** foi alterado.

## 2. Fluxo anterior × integrado

**Antes**

```
PDV → X-Empresa-Id → POST /api/vendas → VendaPagamentoService
      (empresa = contexto do operador)
```

**Depois (MULTIEMPRESA + origem PDV)**

```
PDV → (header ainda enviado) → POST /api/vendas
  → VendaApplicationService MULTIEMPRESA
  → SelecaoEmpresaVendaPdvService (capacidade + política + caixa)
  → req.empresaId = empresa selecionada
  → VendaPagamentoService (núcleo oficial)
```

Preview somente leitura: `POST /api/vendas/selecao-empresa`.

## 3. Arquivos alterados / criados

| Arquivo | Ação | Justificativa |
|---|---|---|
| `backend/services/vendas/SelecaoEmpresaVendaPdvService.js` | Criado | Orquestra capacidade, R04–R11, caixa, override de empresa no request |
| `backend/services/vendas/VendaApplicationService.js` | Alterado | Gancho MULTIEMPRESA antes do núcleo |
| `backend/rotas/vendas.js` | Alterado | Endpoint preview `POST /selecao-empresa` |
| `backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa.js` | Alterado | R04: bloquear matriz ausente (não promover filial) |
| `backend/motores/muv/capacidade/selecionarEmpresaCapacidade.js` | Alterado | Códigos `MATRIZ_AUSENTE`, `CAIXA_INCOMPATIVEL`, `TIPO_SALDO_INDETERMINADO` |
| `frontend/pdv/js/pdv.js` | Alterado | Banner informativo + `selecao_hash` + mensagens de bloqueio |
| `tests/pdv/pdv-sel-01-selecao-empresa.test.js` | Criado | T01–T17 + concorrência em `:memory:` |
| `docs/arquitetura/PDV-SEL-01-RELATORIO.md` | Criado | Este relatório |

**Não alterados:** PDV Universal, motor fiscal/SEFAZ, schema, instalador, MUC `public.js`.

## 4. Decisões e serviços reutilizados

| Tema | Decisão homologada aplicada |
|---|---|
| Matriz | CNPJ `0001`; ausente/ambígua → bloqueio (R04) |
| Filiais | `empresas.id ASC` (R03) |
| Fiscal | `exigirFiscalValido` só se `emitir_fiscal === true` (R05/T09–T10) |
| Saldo | `emitir_fiscal` / `venda_fiscal` → FISCAL ou NAO_FISCAL; ausente → bloqueio (R08/T17) |
| Caixa | Sessão deve ser da empresa selecionada; sem troca automática (R07/T08) |
| Precedência | Servidor sobrescreve header/body (R01/R11/T11) |

Reutilizados: `avaliarCapacidadeCarrinho`, `escolherMatrizPadrao`, `consultarDisponibilidade`, `montarLinhasConsumo` / ficha, `exigirSessaoDaEmpresa`, `VendaPagamentoService` (inalterado na baixa).

## 5. Resultados dos testes

Comando:

```text
node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js
→ 18 pass / 0 fail
```

Regressão CAP:

```text
node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
→ 10 pass / 0 fail
```

| ID | Resultado |
|---|---|
| T01 | PASS — matriz |
| T02 | PASS — filial menor `id` |
| T03 | PASS — bloqueio sem soma |
| T04 | PASS — gargalo de insumo |
| T05 | PASS — revalidação após baixa |
| T06 | PASS — hash do carrinho |
| T07 | PASS — `MATRIZ_AUSENTE` |
| T08 | PASS — `CAIXA_INCOMPATIVEL` |
| T09 | PASS — fiscal inválido inelegível |
| T10 | PASS — sem emissão não exige fiscal |
| T11 | PASS — servidor prevalece |
| T12 | PASS — sem acesso |
| T13 | PASS — sem controle de estoque |
| T14 | PASS — EMPRESA_SIMPLES |
| T15 | PASS — peso/KG com precisão existente |
| T16 | PASS — `req.empresaId` / snapshot únicos |
| T17 | PASS — tipo saldo indeterminado |
| Concorrência | PASS — 2ª revalidação após baixa oficial falha |

## 6. Evidências de isolamento

- Testes usam exclusivamente `sqlite3.Database(':memory:')`.
- Nenhum `CDS_ALLOW_OFFICIAL_DB=1`.
- Nenhum acesso a `ProgramData` / banco de cliente nesta sprint.

## 7. Concorrência e atomicidade

A sprint **não** criou reserva paralela. A concorrência foi validada como: consulta → baixa via `EstoqueEmpresaService.aplicarEfeitoSaldo` (primitiva oficial) → nova consulta bloqueia. A atomicidade da finalização continua a cargo do núcleo (`VendaPagamentoService` + débito/estoque existentes). Não houve evidência, nesta sprint, de lacuna que exigisse interromper a integração; E2E HTTP paralelo de duas `POST /api/vendas` permanece para PDV-SEL-02.

## 8. Limitações e riscos

- Preview UI é best-effort (debounce); a autoridade é sempre a revalidação no `POST /api/vendas`.
- T16 cobre o ponto de integração (`req.empresaId`); não executa insert completo de venda HTTP nesta suíte.
- Middleware de caixa ainda resolve sessão pela empresa do header **antes** da seleção; se a empresa selecionada for outra, R07 bloqueia (comportamento desejado). Operador precisa ter caixa aberto na empresa que o seletor escolherá (tipicamente a matriz).
- Vendas mistas F×NF complexas: capacidade usa um único `tipoSaldo` derivado de `emitir_fiscal`/`venda_fiscal` (R08). Cenários mistos granulares → PDV-SEL-02.

## 9. SEFAZ e dados oficiais

Confirmado: nenhuma emissão, consulta ou manifestação SEFAZ; nenhum banco oficial/cliente alterado; nenhum instalador gerado.

## 10. Resultado

**APROVADA** — critérios de aceite da especificação atendidos com as limitações da §8. Próxima etapa sugerida: **PDV-SEL-02** (homologação isolada ampliada e E2E de vínculo venda↔empresa).
