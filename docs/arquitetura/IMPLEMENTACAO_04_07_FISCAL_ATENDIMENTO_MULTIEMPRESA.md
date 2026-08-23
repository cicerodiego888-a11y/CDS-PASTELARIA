# Implementação 04.07 — Fiscal do atendimento MULTIEMPRESA + comprovante unificado

**Status:** concluída · **Pré-requisito:** atendimento `CONCLUIDO` (04.06)  
**Não inclui:** impressão física, TEF/PIX multiempresa, cancelamento fiscal multiempresa, UI, 04.08

## 1. Auditoria do fluxo fiscal existente

O emissor oficial é `backend/services/fiscal/emissor.js` → `emitirPorVendaId(vendaId)`.

| Ponto | Comportamento |
|---|---|
| Entrada | somente `vendaId` — não recebe `empresa_id` |
| Idempotência | se `nfce_notas.status = autorizada`, reutiliza |
| XML / QR / DANFE | persistidos em `nfce_notas` (`xml_enviado`, `chave_acesso`, `qr_code_url`) |
| Estoque / pagamento | **não** baixa, **não** cobra, **não** materializa venda |
| Config fiscal | `getFiscalConfig()` global (não por empresa neste runtime) |

O orquestrador MUV **não** implementa NFC-e. Coordena:

```
ATENDIMENTO → operação (empresa_id persistido) → venda_id persistido
            → emissor.emitirPorVendaId(vendaId)
            → nfce_notas (oficial)
            → atendimento_operacao_documentos (referência)
```

## 2. Autoridade empresarial

Para cada operação:

- `atendimento_operacoes.empresa_id` é a autoridade
- `atendimento_operacoes.venda_id` é a venda oficial

`body.empresa_id`, query, CNPJ do frontend, empresa 1 e contexto HTTP **não** substituem.

O segundo argumento do emissor (`{ empresaId }`) é metadado de auditoria; o motor oficial continua chaveado por `vendaId`.

## 3. Orquestrador

`FiscalizarAtendimentoService.fiscalizarAtendimento(atendimentoId, deps)`

- Status elegível: `CONCLUIDO`, `FISCALIZANDO`, `FISCAL_PARCIAL`, `FISCAL_ERRO`, `FISCALIZADO`
- Por operação: se já `AUTORIZADA`, reutiliza (retry)
- Se todos os itens são `NAO_FISCAL`: `NAO_APLICAVEL` (não chama o emissor)
- Caso contrário: `deps.emitirPorVendaId || emissor.emitirPorVendaId`
- Upsert em `atendimento_operacao_documentos`
- Consolida o atendimento

Wrapper: `VendaApplicationService.fiscalizarAtendimento` — **somente** `MULTIEMPRESA`.

## 4. Vínculo (referências, sem copiar XML)

Tabela `atendimento_operacao_documentos`:

- `atendimento_id`, `atendimento_operacao_id` (UNIQUE), `empresa_id`, `venda_id`
- `nfce_nota_id`, `chave_acesso`, `numero`, `serie`, `qr_code_url`
- `status`, `erro_codigo`, `erro_mensagem`, timestamps

O XML permanece em `nfce_notas`.

## 5. Estados

| Atendimento | Significado |
|---|---|
| `FISCALIZANDO` | ciclo em andamento |
| `FISCALIZADO` | todas as operações aplicáveis autorizadas (ou só `NAO_APLICAVEL`) |
| `FISCAL_PARCIAL` | ao menos uma autorizada e ao menos uma rejeitada/erro |
| `FISCAL_ERRO` | nenhuma aplicável autorizada |

Operação: `PENDENTE`, `AUTORIZADA`, `REJEITADA`, `NAO_APLICAVEL`, `ERRO`.

## 6. Sucesso parcial, retry, atomicidade

Autorização SEFAZ **não** entra em uma TX SQLite única. Cada resultado é persistido sozinho.

A autorizada + B autorizada + C rejeitada = `FISCAL_PARCIAL`. A e B **não** são apagados.

Retry: não reemite `AUTORIZADA`; processa pendente/rejeitada/erro.

Erro local após persistir a primeira operação **não** apaga o vínculo já gravado; o cabeçalho não vira `FISCALIZADO`.

## 7. Comprovante unificado (contrato de dados)

`obterComprovanteUnificado` / retorno de `fiscalizarAtendimento.comprovante`

- `tipo`: `COMPROVANTE_UNIFICADO_ATENDIMENTO`
- Itens em **lista contínua** ordenada por `itemId` (ordem comercial). Sem `empresaId` no item. `itensAgrupadosPorEmpresa: false`
- `total` = `atendimentos.valor_total` (não recalcula)
- Pagamento **unificado** (formas do atendimento; rateios internos não viram seções de cliente)
- `documentosFiscais` identificados por `empresaId`

Invariantes no contrato: `totalAtendimento`, `somaOperacoes`, `somaPagamentos`.

## 8. O que esta sprint não faz

- Não cobra, não baixa estoque, não consome reserva, não cria venda
- Não altera EMPRESA_UNICA / PDV / TEF / NFC-e unitária
- Não imprime DANFE/comprovante físico
- Materialização 04.06 ainda não preenche `quantidade_fiscal` / `valor_fiscal` em `vendas_itens`; o emissor real pode retornar `sem_itens_fiscais` até essa coluna existir. Testes injetam `emitirPorVendaId`. Config fiscal global (não por CNPJ da operação) permanece limitação do motor existente.

## 9. EMPRESA_UNICA

`criarVenda` continua delegando a `VendaPagamentoService`. Nenhum atendimento oculto.
