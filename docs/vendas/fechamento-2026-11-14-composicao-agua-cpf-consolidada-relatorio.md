# Fechamento — 14/11/2026

Composição dinâmica (refrigerante/água), UX de consolidada e CPF na nota, e auditoria do dinheiro na NFC-e 100033.

## Resultado

1. O motor do Pedido → PDV deixou de depender de allowlist fixa de volumes (150/200/300/500 ml). Refrigerante fiscal novo na categoria **Refrigerantes**, com volume MUC válido, preço e estoque, passa a competir sozinho no residual.
2. Água comercial (**Água** / **Águas**) passa a alimentar o residual fiscal `AGUA`. Pastel permanece pela quantidade do pedido. Água sem volume MUC, porém com preço (e estoque quando controla), entra **por unidade** — corrige o falso `AGUAS_INSUFICIENTES` quando há estoque (ex.: Agua Mineral).
3. A modal **Gerar venda consolidada da mesa** fecha no encaminhamento ao PDV (e também se a lista sincronizar pós-venda com a modal ainda aberta).
4. Com F12 fiscal, o modal **CPF/CNPJ na Nota** abre **antes** da forma de pagamento; a finalização reutiliza o valor capturado.
5. NFC-e 100033: o dinheiro no XML (R$ 5,20) é complemento fiscal da recomposição, não o dinheiro comercial do caixa (R$ 26,00). Contas conferem; nenhum código fiscal foi alterado neste ponto.

## Causa corrigida

| Sintoma | Causa | Correção |
|---|---|---|
| Copo 150 ml cadastrado ignorado | Allowlist `Set([150,200,300,500])` no carregamento de modelos | Remoção da allowlist; elegibilidade por volume MUC positivo |
| Pedido com água → `AGUAS_INSUFICIENTES` com estoque | Motor só buscava refrigerante; água sem `utiliza_volume` era invalidada | Roteamento por categoria comercial → `AGUA`; unidade sem MUC só para água |
| Modal consolidada aberta após handoff / venda | Sucesso do POST não escondia o Bootstrap modal | `fecharModalConsolidada()` no sucesso + no tick da lista |
| CPF no fim do fluxo | `mostrarModalCpfCnpjNota` só após pagamento | Captura em `abrirTelaPagamentoBalcao` com `pdvCpfCnpjNotaValor` |

## Contrato implementado

### Composição (`PedidoPdvComposicaoService`)

1. Modelos de bebida: `carregarModelosBebidaVolume` com categorias fiscais `REFRIGERANTE` e/ou `AGUA`, derivadas do cadastro comercial (nome normalizado sem acento).
2. Pedido só com refrigerante e/ou água (sem pastel) → núcleo residual (valor → unidades + desconto técnico).
3. Pedido com pastel → pastéis cotados; residual preenchido pelas bebidas tipadas no pedido; se não houver bebida tipada (ex. venda por valor), residual continua em refrigerante.
4. Refrigerante: exige volume comercial + conversão MUC.
5. Água: com MUC usa ml; sem MUC usa `volumeMlPorUnidade = 1` (`UNIDADE_AGUA_SEM_VOLUME_MUC`).
6. Modo de resposta permanece `COMPOSICAO_PASTEL_REFRIGERANTE` (compatibilidade com consolidada/PDV).

### ERP Pedidos

- Após reserva consolidada válida e antes/ao abrir o PDV: fecha modal e recarrega lista.
- Tick `cds_pedidos_lista_tick` com modal aberta: fecha a consolidada e recarrega.

### PDV

- F12 fiscal: CPF/CNPJ → pagamento → finalização com CPF já definido.
- Sem F12 / implantação sem fiscal: fluxo de pagamento inalterado.
- Limpeza do CPF capturado em limpar carrinho, cancelar venda e pós-venda.

## Evidência

### Automatizada

- `node --test tests/vendas/pedido-pdv-composicao.test.js` → **24 passaram, 0 falharam** (14/11/2026).
- Novos/ajustados: volume MUC novo (100 ml); produto fiscal 150 ml; pedido com água MUC; água sem MUC + estoque.

### Operacional (leitura do banco oficial, sem escrita)

- NFC-e **100033** / venda **#113** (homologação):
  - Comercial: total R$ 56,98 = PIX R$ 30,98 + dinheiro R$ 26,00.
  - XML: `vNF` 36,18 = `tPag` 17 → 30,98 + `tPag` 01 → **5,20**; `vDesc` 0.
  - Itens: pastel fiscal 17,98; refrigerante 150 ml com parte fiscal 18,20 e não fiscal 20,80.
  - Interpretação: 5,20 = complemento de dinheiro fiscal; 20,80 + 5,20 = 26,00.

## Arquivos desta implementação

- `backend/services/vendas/PedidoPdvComposicaoService.js`
- `tests/vendas/pedido-pdv-composicao.test.js`
- `frontend/erp/js/pedidos.js`
- `frontend/pdv/js/pdv.js`

## Validação executada

- Suíte focal de composição Pedido–PDV: 24/24.
- Conferência pontual no SQLite operacional (`ProgramData\MercantilFiscal\dados`) apenas em leitura para NFC-e 100033.
- **Não** houve commit Git neste ciclo (alterações locais pendentes de versionamento pelo responsável).

## Limites de homologação

- Reinício/reload do backend e do PDV necessários para pegar JS/serviço novos em sessão já aberta.
- Sem E2E automatizado da modal consolidada nem do CPF antes do pagamento.
- Sem alteração em `xmlBuilder` / recomposição de pagamento; o dinheiro 5,20 vs 26,00 é comportamento atual documentado, não bug de soma.
- DANFE HTML da 100033 apresentou totais/itens distintos do XML autorizado — **fora do escopo** deste fechamento; candidato a sprint à parte.
- Pastel não entra como descoberta fiscal alternativa por cadastro; continua pela linha do pedido.

## Pendências sugeridas (próximo ciclo)

1. Homologar na mesa real: pedido só água; pastel+água; consolidada mista água+refrigerante.
2. Versionar (commit) as quatro alterações de código/teste.
3. Investigar divergência DANFE × XML na emissão.
4. Opcional: alinhar documentação antiga que ainda cita allowlist 200/300/500 (`docs/vendas/sprint-2.1-composicao-dinamica-pedido-pdv-relatorio.md`).

## Critério de aceite deste fechamento

- [x] Refrigerante novo elegível sem alterar código de volumes.
- [x] Água no pedido usa modelos de água; sem MUC não gera falso insuficiente se preço ok.
- [x] Modal consolidada não permanece após encaminhar ao PDV.
- [x] CPF/CNPJ solicitado antes do pagamento no modo fiscal.
- [x] Dinheiro da NFC-e 100033 auditado e explicado.
- [ ] Commit / release — a cargo do responsável após este relatório.
