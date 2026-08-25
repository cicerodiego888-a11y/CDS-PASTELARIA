# LISTA — FUNCIONALIDADES JÁ EXISTENTES NO PDV UNIVERSAL

**STATUS dominante:** JÁ SUBSTITUÍDO PELO UNIVERSAL (arquitetura) — a UX ainda é mais pobre que o legado.

## Contexto e modos

- Rota oficial `/pdv-universal/` + licença `pdv`.
- `GET /api/pdv-universal/contexto` (LOADING / ERROR / READY).
- 409 `NENHUMA_EMPRESA_DISPONIVEL` sem forçar logout.
- Seleção de empresa (`POST /contexto/empresa`, modal).
- Exibição de modo `EMPRESA_UNICA` | `MULTIEMPRESA` via `resolverModoOperacaoVendaAtivo()`.
- Lista “empresas no atendimento”.
- Modal “produto possui estoque em…” + `GET .../disponibilidade`.

## Carrinho / atendimento

- Busca `GET /api/produtos/consulta-pdv/buscar`.
- Carrinho em memória com `empresa_id` no item (`pdv-universal-cart.js`).
- Totais de itens e valor.
- Estados de sessão (`pdv-universal-session.js`) — atalhos bloqueáveis.

## Checkout e pós-venda

- `POST /api/pdv-universal/checkout` (idempotency-key).
- Middleware `validarCaixaSeOrigemPdv` no checkout.
- **EMPRESA_UNICA:** `EmpresaUnicaAdapter` → `VendaApplicationService.criarVenda` (sem `POST /api/vendas` no browser).
- **MULTIEMPRESA:** `AtendimentoMultiempresaService.criarAtendimento`.
- Reserva `POST .../reservar`.
- Pagamento unificado múltiplas linhas `POST .../pagamento` (estratégia `POR_ITEM`).
- Cancelar atendimento `POST .../cancelar`.
- Materializar `POST .../materializar`.
- Fiscalizar `POST .../fiscalizar` (cadeia fiscal por empresa da operação).
- Comprovante GET + preview iframe + preparar impressão.
- Novo atendimento (reset visual de sessão).

## Pagamento (parcial)

- Enum UI: dinheiro, PIX, débito, crédito.
- Soma / diferença no modal.
- ESC fecha modal **sem** cancelar pagamento.

## Atalhos oficiais atuais (respeitar)

| Atalho | Universal |
|--------|-----------|
| F1 | Foco busca |
| ESC | Fecha modal; não cancela pagamento |

Não restaurar automaticamente F4–F11 do legado.

## O que o Universal **não** afirma ter (evitar duplicar)

- Motor de vendas paralelo (não existe — reusa VAS/MUV).
- Motor fiscal paralelo.
- Serviço próprio de pesagem (não há no frontend; Motor Equipamentos é backend compartilhado).
- Tela de caixa / entregas / TEF / PIX cobrança.

## Arquitetura-alvo (já desenhada no código)

```
PDV UNIVERSAL
    ↓
Empresa Única / Multiempresa
    ↓
Motor Universal de Vendas (VAS) / MUV
    ↓
Fiscal + Estoque + Financeiro
```
