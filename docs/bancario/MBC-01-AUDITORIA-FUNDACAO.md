# MBC-01 — Auditoria e fundação do Motor Bancário & Conciliação

STATUS: auditoria concluída · fundação mínima criada · **sem Open Finance**

Projeto: CDS Pastelaria. Não importa regras de Açaíteria, cubas, iFood ou outros CDS.

---

## 1. Resumo da descoberta

O Pastelaria **já possui um financeiro empresarial** (lançamentos, contas a receber, pagamentos de venda, compras → despesa, caixa físico, TEF, PIX de cobrança).

**Não possui** Motor Bancário: não há tabela de conta corrente, extrato, instituição financeira (COMPE/ISPB), conciliação bancária, OFX, OAuth bancário nem Open Finance operacional.

Conciliação existente é **TEF × venda** (adquirência), não extrato × financeiro.

PIX existente é **meio de pagamento / cobrança de provedor** (Mercado Pago / Stone), não transação de conta da empresa.

---

## 2. Mapa do financeiro atual

```
VENDA (vendas.empresa_id)
  → venda_pagamentos (forma, valor, NSU TEF)
  → venda_recebimentos (tipo fiscal/não fiscal)
  → contas_receber (prazo; empresa_id)
  → contas_receber_pagamentos (baixa; sem empresa_id próprio)
  → financeiro tipo=receita (empresa_id obrigatório em writers novos)

COMPRA (compras.empresa_id)
  → financeiro tipo=despesa, referencia_tipo=compra, compra_id
  → baixa/status no próprio financeiro (pago / pendente)

CAIXA FÍSICO (caixa_sessoes.empresa_id)
  → caixa_movimentacoes (sangria/suprimento)
  → NÃO é conta bancária
```

Identificador do lançamento: `financeiro.id`. Origem: `origem`, `referencia_tipo` + `referencia_id`, `venda_id`, `compra_id`. Baixa: `status` + `baixado_em`. Data: `data_movimento` / `vencimento`. Forma: texto livre `forma_pagamento`.

Nesta sprint o fluxo **não foi alterado**.

---

## 3. Tabelas (auditoria)

| Tabela | Finalidade | empresa_id | Observação |
|--------|------------|------------|------------|
| `financeiro` | Livro de receitas/despesas | SIM (05.38.D / 05.41) | Contas a **pagar** são `tipo=despesa` pendente. Não há `CREATE TABLE contas_pagar`. |
| `contas_receber` | Parcelas de venda a prazo | SIM | Status aberto/parcial/quitado etc. |
| `contas_receber_pagamentos` | Baixas de CR | NÃO | Ownership via `conta_receber_id`. |
| `venda_pagamentos` | Split da venda | NÃO | Ownership via `venda_id`. TEF: nsu, autorização. |
| `venda_recebimentos` | Recebimento F/NF | NÃO | Via `venda_id`. |
| `vendas` | Operação comercial | SIM | |
| `compras` | Entrada de mercadoria | SIM | |
| `caixa` / `caixas` / `terminais` | Turno e cadastro de caixa | cadastro sem empresa_id | Sessão: `caixa_sessoes.empresa_id`. |
| `caixa_movimentacoes` | Sangria/suprimento | NÃO | Via sessão. |
| `caixa_fechamentos` | Fechamento por forma (dinheiro, pix, débito…) | NÃO | |
| `tef_transacoes` | Autorização pinpad | NÃO | `idempotency_key` UNIQUE. NSU. |
| `tef_conciliacao` / `tef_conciliacoes` | Conciliação **adquirente** | NÃO | D para o MBC. |
| `tef_servidores` | client_id/secret, tokens | NÃO | **Segredo em texto no SQLite.** |
| `pix_cobrancas` | Cobrança PIX | NÃO | `txid`, `raw_json`. |
| `configuracoes` | `pix_configs_json` | global | Possíveis chaves de API. |
| instituição / conta bancária / extrato | — | — | **Inexistente.** |

`validateInsertAlignment` lista `contas_pagar`, mas **não há schema** dessa tabela no `database.js`. O dashboard usa `financeiro` despesa.

---

## 4. Multiempresa

Reutilizar: `UsuarioEmpresaService`, `X-Empresa-Id` / `req.empresaId`, `empresa_operacional_id` (EMPRESA_SIMPLES), `FinanceiroEmpresaContextoService`, `VendaEmpresaContextoService`.

Não encontrado `empresa_id = 1` como fallback no financeiro atual (sprints 05.38–05.41). Legado `NULL` existe e é tratado como fora da lista operacional.

Riscos de ownership para o MBC futuro:

- `venda_pagamentos`, `venda_recebimentos`, `pix_cobrancas`, `tef_*` sem `empresa_id`.
- Cadastro `caixas` sem `empresa_id`.

Não corrigidos nesta sprint.

---

## 5. Pagamentos e recebimentos

Formas (texto, sem cadastro mestre estável):

- Venda NF: `pix`, `dinheiro`, `cartao`, `cartao_pf`, `outro`; TEF fiscal: `cartao_debito`, `cartao_credito`.
- Compra: inclui `boleto`, `transferencia`, `deposito`, vales, etc. (`compras.js`).
- Caixa fechamento: dinheiro, pix, débito, crédito, prazo, tef, outros.

Vínculo transação cartão: `venda_pagamentos.tef_transacao_id` + NSU. Não há vínculo com extrato bancário.

PIX venda: forma `pix` e/ou `pix_cobrancas.txid`. Não é movimento da conta da pastelaria.

---

## 6. Contas a pagar / receber

**Pagar:** `financeiro.tipo = 'despesa'` e status não pago/recebido/cancelado. Criado na compra (`referencia_tipo='compra'`).

**Receber:** tabela `contas_receber` (saldo em aberto — MIS usa aberto/parcial) **e** receitas pendentes em `financeiro`. Dashboard soma as duas origens.

---

## 7. Caixa físico vs banco

Caixa = numerário do turno na loja. Banco = conta da pessoa jurídica.

Sangria/suprimento **não** devem virar transação bancária automaticamente. Podem ser **candidatas** futuras de conciliação se houver depósito correspondente no extrato (sprint posterior).

---

## 8. Integrações existentes (não são Open Finance)

| Integração | Papel | Classificação MBC |
|------------|-------|-------------------|
| TEF | Autorização cartão | **D** como extrato; **A** NSU para match futuro com adquirência |
| PIX providers | Cobrança | **A** como meio; **D** como conta; `txid` **B** para match |
| DistDFe / NFC-e | Fiscal | **D** |
| Central de Entradas | XML compra | **D** (já gera financeiro via compras) |

Não há OFX, webhook bancário, endToEndId de conta, COMPE.

---

## 9. Matriz de reaproveitamento

| Item | Existe | Empresa | Reaproveitar | Adaptar | Criar | Observação |
|------|--------|---------|--------------|---------|-------|------------|
| Lançamento financeiro | Sim | Sim | A | | | Alvo da conciliação; não duplicar |
| Contas a receber | Sim | Sim | A | | | Vínculo futuro |
| Contas a pagar (tabela) | Não | — | | | | Usar `financeiro` despesa |
| Formas de pagamento | Texto | — | A | B | | Sem catálogo bancário |
| Caixa | Sim | Sessão | A (separar) | | | Não misturar |
| TEF conciliação | Sim | Não | D | | | Outro domínio |
| Conta bancária | Não | — | | | C | MBC-02 |
| Instituição (ISPB/COMPE) | Não | — | | | C | MBC-02 |
| Transação/extrato | Não | — | | | C | MBC-03 |
| Idempotência extrato | Não | — | A ideia TEF | | C | Unique empresa+conta+fonte+id |
| Provider bancário | Não | — | A ideia TEF/PIX adapter | | C | IBankProvider |
| Open Finance | Não | — | | | | Camada **acima** do motor |
| Secrets | TEF/PIX em SQLite | — | | B | | Vault; nunca texto puro no MBC |
| Contexto empresa | Sim | Sim | A | | | `resolverEmpresaIdParaBancario` |
| MIS / Dashboard | Sim | Sim | D | | | Sem MIS bancário agora |

**A** reaproveitar · **B** adaptar depois · **C** criar · **D** não usar como banco.

---

## 10. Modelo conceitual oficial

```
EMPRESA
  └── CONTA_BANCARIA (1 empresa; nunca compartilhada)
        ├── INSTITUICAO_FINANCEIRA (COMPE/ISPB estável)
        └── CONFIG_INTEGRACAO (segredos fora do SQLite em texto)
              └── PROVIDER → DTO normalizado
                    └── TRANSACAO_BANCARIA (imutável no núcleo)
                          └── CONCILIACAO (vínculo, não substitui o extrato)
                                └── financeiro | contas_receber | venda | compra | transferência
```

Direções: `entrada` | `saida` | `transferencia` (natureza própria; interna vs interempresa futura).

Saldos: **informado pelo banco** ≠ **calculado pelo sistema**.

---

## 11. Idempotência (definição, não implementação de sync)

Canônica: `empresa_id + conta_bancaria_id + external_source + external_id`.

Sem `external_id`: fallback documental `empresa + conta + data + valor + direção + descrição` (colisão possível — registrar `divergente`).

A mesma transação duas vezes não cria dois registros. **Não sincronizar na MBC-01.**

---

## 12. Conciliação (conceitual)

Estados: `pendente` | `conciliada` | `ignorada` | `divergente`.

Conciliar = **vínculo**. Preservar valor, descrição e id externo originais.

Não apagar transação. Não gerar CR/CP automaticamente.

PIX: meio de pagamento **e** possível atributo da transação (`endToEndId` futuro), não módulo paralelo.

Cartões/adquirência: sprint própria; TEF já existe.

---

## 13. Provider e Open Finance

```
Open Finance / OFX / manual
    → IBankProvider (normaliza)
    → Motor Bancário
    → transações
    → conciliação
    → financeiro existente
```

DTO: `externalId`, `externalSource`, `accountId`, `date`, `amount`, `direction`, `description`, `type`, `rawReference` (+ `empresa_id` obrigatório).

Payload bruto: referência opcional **sem tokens**. Não armazenar nesta sprint.

---

## 14. APIs futuras (não implementadas)

`GET/POST/PUT/DELETE /api/bancario/contas`  
`GET /api/bancario/transacoes`  
`POST .../conciliar` `.../desconciliar`  
`GET /api/bancario/conciliacao`

Serviços futuros: `ContaBancariaService`, `TransacaoBancariaService`, `ConciliacaoBancariaService`, `ProviderBancarioService`. Hoje só o contrato em `MotorBancarioService`.

---

## 15. Inventário de código (amostra)

| Arquivo | Função atual | Reaproveitar? | Risco | Ação futura |
|---------|----------------|---------------|-------|-------------|
| `backend/rotas/financeiro.js` | CRUD lançamentos, CR | A alvo | SQL na rota | Não acoplar OF |
| `backend/services/financeiro/FinanceiroEmpresaContextoService.js` | Ownership | A | — | Reuso padrão |
| `backend/services/vendas/VendaPagamentoService.js` | Formas + CR | A | — | Candidatas |
| `backend/rotas/compras.js` | Despesa financeira | A | — | Candidatas |
| `backend/rotas/caixa.js` | Caixa físico | D como banco | — | Manter separado |
| `backend/rotas/tef*.js` + `tefConciliacao*` | Adquirência | D | Tokens no DB | Não misturar |
| `backend/rotas/pix.js` + `pixService.js` | Cobrança | B txid | Config JSON | Não virar MBC |
| `backend/monitoring/providers/RecebimentosProvider.js` | PIX/dinheiro/cartão | D | Global | Fora do MBC |
| `frontend/erp/js/compras.js` | Formas incl. transferência | A rótulos | — | Não é conta |

---

## 16. Riscos

1. Confundir TEF/PIX com extrato da conta.  
2. Secrets TEF/PIX em SQLite.  
3. Tabela fantasma `contas_pagar`.  
4. Entidades de pagamento sem `empresa_id`.  
5. Duplicar receita se a sync gravar `financeiro` direto.  
6. Transferência interna classificada como despesa.

---

## 17. Fundação implementada

`backend/motores/bancario/` — constantes, DTO, `IBankProvider` stub, contexto empresarial, `MotorBancarioService` (contrato; listagens vazias; importar/conciliar = 501 sem gravar financeiro). Sem rotas HTTP. Sem migration.

---

## 18. Roadmap ajustado (auditoria)

1. **MBC-02** — instituições + contas bancárias (CRUD, empresa_id, sem credencial em claro).  
2. **MBC-03** — transações + unique de idempotência + saldos conceituais.  
3. **MBC-04** — vínculo de conciliação manual mínimo (sem algoritmo automático).  
4. **MBC-05** — adapter/provider + política de secrets (ainda sem OAuth de banco).  
5. **MBC-06** — Open Finance consentimento/conexão.  
6. **MBC-07** — sincronização de saldo/extrato.  
7. **MBC-08** — sugestão automática de conciliação + PIX/TEF como candidatos.  
8. **MBC-09** — homologação.

Open Finance **depois** do modelo de conta e transação.
