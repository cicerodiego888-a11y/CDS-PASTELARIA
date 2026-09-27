# IMPLEMENTAÇÃO MBC-14.4.1

SPRINT: MBC-14.4.1

STATUS: CONCLUÍDA

Classificação: **REDESIGN UX/UI DA INTEGRAÇÃO BANCÁRIA**

Não declarar Mercado Pago integrado, OAuth real concluído nem banco conectado.

## Objetivo

Reorganizar a tela Contas Bancárias → Integração para hierarquia clara:

Empresa → Conta → Integração → Instituição → Provider → Ambiente → Credenciais → Autorização → Operação

## Arquivos alterados

- `frontend/erp/pages/contas-bancarias.html`
- `frontend/erp/js/contas-bancarias.js`
- `backend/motores/bancario/version.js` (SPRINT = MBC-14.4.1)
- `tests/bancario/motor-bancario-14-4.test.js` (assert de sprint flexível)
- `tests/bancario/motor-bancario-14-4-1.test.js` (novo)
- `docs/bancario/MBC-14.4.1-RELATORIO.md`

## Alterações visuais / navegação

- Painel com card (`mbc-tx-painel`), header da conta + Empresa/CNPJ
- Abas: Configuração | Autorização | Operação
- Provider como select genérico (valor atual: Mercado Pago)
- Instituição / Banco separado do Provider
- Status em badges (credenciais / autorização) — sem “Conectado”
- MOCK em área colapsável “Avançado / Homologação interna”
- Botão **Voltar para contas**
- Na listagem, **Integração** como ação primária (`btn-primary`)
- Linha da conta selecionada destacada

## Hierarquia

A UI passa a comunicar, nesta ordem visual:

1. Empresa (nome + CNPJ da dona da conta; nunca “Todas” como proprietária)
2. Conta / instituição / agência·conta
3. Integração bancária (conceito principal)
4. Provider (campo genérico)
5. Ambiente
6. Credenciais
7. Autorização (aba separada)
8. Operação (sync / saldo / extrato)

## Preservado

- APIs MBC-14.4 de credenciais
- SecretStore / Client ID / Client Secret (campo password, sem exibir secret existente)
- IDs de formulário e handlers (`mbcMp*`, `mbcCfg*`, `mbcOf*`, sync/extrato)
- Multiempresa (visão Todas / individual)
- Sem alteração de backend de domínio, OAuth, PKCE, gateway, banco
- Funcionalidade MOCK mantida (apenas reposicionada)

## Segurança

- Client Secret continua `type="password"` / `autocomplete="new-password"`
- Frontend não recebe nem exibe o secret após salvar
- SecretStore e rotas de credenciais inalterados

## Testes

Executados com `node --test`:

| Suite | Resultado |
|-------|-----------|
| MBC-01 … MBC-13 | OK |
| MBC-14.1, 14.2, 14.3, 14.4 | OK |
| MBC-14.4.1 (novo) | OK — 6 testes |
| **Total MBC (01…14.4.1)** | **652 pass / 0 fail** |
| Financeiro 05.38.D | OK |
| Financeiro 05.41 | OK |
| Caixa 05.38.C | OK |
| Vendas 05.40 | OK |
| Compras 05.64 | OK |
| **Módulos relacionados** | **5 pass / 0 fail** |

## Teste visual

Não executado em browser/Electron nesta entrega (ambiente sem sessão UI automatizada).

Checklist recomendado para validação manual:

1. Listagem Contas Bancárias
2. Visão empresa individual e “Todas”
3. Abrir Integração / Voltar
4. Abas Configuração / Autorização / Operação
5. Credenciais (salvar / limpar / status)
6. Área Avançado (MOCK)
7. Destaque da linha selecionada e Empresa/CNPJ no header

## Pendências

- Validação visual manual no ERP/Electron
- Providers reais (BB, Sicredi, etc.) — fora do escopo
- OAuth / autorização real — fora do escopo (estado “não autorizado” permanece)

## Status final

**CONCLUÍDA** — redesign UX/UI da integração bancária, sem alteração de regras do Motor Bancário.
