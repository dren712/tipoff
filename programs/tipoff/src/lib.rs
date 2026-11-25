//! Tipoff: six traders, one secret insider, sixty seconds.
//!
//! Public state (`Table`) and hidden state (`Secret`, `SeatPrivate`) are delegated to a
//! MagicBlock Private Ephemeral Rollup. VRF picks the insider and the news shocks, the
//! pricing oracle supplies the live SOL price, and votes stay sealed until `settle`.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
    TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self as vrf_sdk,
    consts::program_identity_pubkey,
    instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

pub mod oracle;
pub mod rules;
pub mod state;

use rules::*;
use state::*;

declare_id!("BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M");

/// The VRF program's signer for callbacks into this program. Kept in a `const` so the PDA is
/// derived at compile time: deriving it inside the callback costs over a million compute units.
const VRF_CALLBACK_IDENTITY: Pubkey =
    Pubkey::new_from_array(vrf_sdk::consts::scoped_vrf_identity_const(&crate::ID).0);
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);

pub const TABLE_SEED: &[u8] = b"table";
pub const SECRET_SEED: &[u8] = b"secret";
pub const SEAT_SEED: &[u8] = b"seat";
pub const PLAYER_SEED: &[u8] = b"player";
pub const LEDGER_SEED: &[u8] = b"ledger";
const MAX_MEMBERS: usize = 2;

#[ephemeral]
#[program]
pub mod tipoff {
    use super::*;

    // ───────────── Solana (base layer) ─────────────

    /// Creates a table and its hidden `Secret`. `salt_commit` seeds the hidden entropy chain.
    pub fn init_table(ctx: Context<InitTable>, id: u64, salt: [u8; 32]) -> Result<()> {
        let t = &mut ctx.accounts.table;
        t.authority = ctx.accounts.authority.key();
        t.id = id;
        t.bump = ctx.bumps.table;
        t.phase = Phase::Idle as u8;
        t.insider = NONE;
        t.votes = [NONE; SEATS];
        let s = &mut ctx.accounts.secret;
        s.table = t.key();
        s.bump = ctx.bumps.secret;
        s.salt = salt;
        s.insider = NONE;
        fund_permission(
            &ctx.accounts.authority,
            &ctx.accounts.secret.to_account_info(),
            &ctx.accounts.system_program,
        )
    }

    pub fn init_seat(ctx: Context<InitSeat>, idx: u8) -> Result<()> {
        require!((idx as usize) < SEATS, TipoffError::BadSeat);
        let p = &mut ctx.accounts.seat;
        p.table = ctx.accounts.table.key();
        p.idx = idx;
        p.bump = ctx.bumps.seat;
        p.vote = NONE;
        fund_permission(
            &ctx.accounts.authority,
            &ctx.accounts.seat.to_account_info(),
            &ctx.accounts.system_program,
        )
    }

    pub fn init_ledger(ctx: Context<InitLedger>) -> Result<()> {
        ctx.accounts.ledger.bump = ctx.bumps.ledger;
        Ok(())
    }

    /// Creates the player's profile and registers the session key that will sign on the rollup.
    pub fn init_player(ctx: Context<InitPlayer>, session: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.player;
        p.wallet = ctx.accounts.wallet.key();
        p.session = session;
        p.bump = ctx.bumps.player;
        Ok(())
    }

    pub fn delegate_table(ctx: Context<DelegateTable>, id: u64) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[TABLE_SEED, &id.to_le_bytes()],
            cfg(&ctx.accounts.validator),
        )?;
        Ok(())
    }

    pub fn delegate_secret(ctx: Context<DelegateChild>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[SECRET_SEED, ctx.accounts.table.key().as_ref()],
            cfg(&ctx.accounts.validator),
        )?;
        Ok(())
    }

    pub fn delegate_seat(ctx: Context<DelegateSeat>, idx: u8) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[SEAT_SEED, ctx.accounts.table.key().as_ref(), &[idx]],
            cfg(&ctx.accounts.validator),
        )?;
        Ok(())
    }

    pub fn delegate_player(ctx: Context<DelegatePlayer>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[PLAYER_SEED, ctx.accounts.wallet.key().as_ref()],
            cfg(&ctx.accounts.validator),
        )?;
        Ok(())
    }

    /// Magic Action target: runs on Solana with the table commit and records the round.
    pub fn record_round(ctx: Context<RecordRound>, round: u64, digest: [u8; 32]) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        if round > l.last_round || l.rounds == 0 {
            l.last_round = round;
            l.last_digest = digest;
            l.rounds = l.rounds.saturating_add(1);
        }
        Ok(())
    }

    // ───────────── Private Ephemeral Rollup ─────────────

    /// Seals the `Secret`: private, with no members. Nobody can read it, the operator included.
    pub fn seal_secret(ctx: Context<SealSecret>) -> Result<()> {
        let table = ctx.accounts.table.key();
        let seeds: &[&[u8]] = &[SECRET_SEED, table.as_ref(), &[ctx.accounts.secret.bump]];
        create_permission(
            &ctx.accounts.secret.to_account_info(),
            &ctx.accounts.perm,
            seeds,
            vec![],
        )
    }

    /// Seals one seat's private account before anyone sits.
    pub fn seal_seat(ctx: Context<SealSeat>) -> Result<()> {
        let table = ctx.accounts.table.key();
        let s = &ctx.accounts.seat;
        let seeds: &[&[u8]] = &[SEAT_SEED, table.as_ref(), &[s.idx], &[s.bump]];
        create_permission(&s.to_account_info(), &ctx.accounts.perm, seeds, vec![])
    }

    /// Takes an empty seat. Only this player's wallet and session key may read the seat's
    /// private account from now on. Without a profile the signer plays as a guest: its key is
    /// both wallet and session key, and nothing has to exist on Solana first.
    pub fn sit(ctx: Context<Sit>, entropy: [u8; 32]) -> Result<()> {
        let t = &mut ctx.accounts.table;
        let signer = ctx.accounts.signer.key();
        let (wallet, session) = match &ctx.accounts.player {
            Some(player) => {
                require!(player.signed_by(&signer), TipoffError::Unauthorized);
                (player.wallet, player.session)
            }
            None => (signer, signer),
        };
        require!(t.phase != Phase::Live as u8 && t.phase != Phase::Pending as u8, TipoffError::WrongPhase);
        let idx = ctx.accounts.seat.idx as usize;
        require!(t.seats[idx].player == Pubkey::default(), TipoffError::SeatTaken);
        require!(!t.seats.iter().any(|s| s.player == wallet), TipoffError::AlreadySeated);
        t.seats[idx] = Seat { player: wallet, session, ..Seat::default() };
        t.entropy = hashv(&[&t.entropy[..], &entropy[..]]).to_bytes();

        let p = &mut ctx.accounts.seat;
        p.reset();
        let table = t.key();
        let seeds: &[&[u8]] = &[SEAT_SEED, table.as_ref(), &[p.idx], &[p.bump]];
        let mut members = vec![member(wallet)];
        if session != wallet {
            members.push(member(session));
        }
        update_permission(&p.to_account_info(), &ctx.accounts.perm, seeds, members)
    }

    /// Leaves a seat between rounds. With a profile, the seat's score is banked into it.
    pub fn stand(ctx: Context<Sit>) -> Result<()> {
        let t = &mut ctx.accounts.table;
        let idx = ctx.accounts.seat.idx as usize;
        let signer = ctx.accounts.signer.key();
        // The table authority may clear a seat so an idle player cannot block the table.
        require!(
            t.seats[idx].signed_by(&signer) || signer == t.authority,
            TipoffError::Unauthorized
        );
        require!(t.phase != Phase::Live as u8 && t.phase != Phase::Pending as u8, TipoffError::WrongPhase);
        if let Some(player) = &mut ctx.accounts.player {
            require!(t.seats[idx].player == player.wallet, TipoffError::BadSeat);
            player.score = player.score.saturating_add(t.seats[idx].score);
            player.rounds = player.rounds.saturating_add(t.seats[idx].rounds);
        }
        t.seats[idx] = Seat::default();
        let p = &mut ctx.accounts.seat;
        p.reset();
        let table = t.key();
        let seeds: &[&[u8]] = &[SEAT_SEED, table.as_ref(), &[p.idx], &[p.bump]];
        update_permission(&p.to_account_info(), &ctx.accounts.perm, seeds, vec![])
    }

    /// Requests randomness for the next round. Anyone may call once every seat is filled.
    pub fn start_round<'info>(
        ctx: Context<'info, StartRound<'info>>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.table;
        let retry = t.phase == Phase::Pending as u8 && now - t.requested_at > VRF_RETRY_SECS;
        require!(
            t.phase == Phase::Idle as u8 || t.phase == Phase::Settled as u8 || retry,
            TipoffError::WrongPhase
        );
        require!(
            t.seats.iter().all(|s| s.player != Pubkey::default()),
            TipoffError::SeatsEmpty
        );
        if !retry {
            t.round += 1;
        }
        // A new nonce supersedes any earlier request for this round.
        t.nonce = t.nonce.wrapping_add(1);
        t.phase = Phase::Pending as u8;
        t.requested_at = now;
        let nonce = t.nonce;
        let table_key = t.key();

        let mut metas = vec![
            meta(table_key, true),
            meta(ctx.accounts.secret.key(), true),
            meta(ctx.accounts.price_feed.key(), false),
        ];
        require!(ctx.remaining_accounts.len() == SEATS, TipoffError::BadSeat);
        for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
            load_seat(ai, &table_key, i)?;
            metas.push(meta(ai.key(), true));
        }
        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: ID,
                callback_discriminator: instruction::OnRandom::DISCRIMINATOR.to_vec(),
                caller_seed: hashv(&[&client_seed[..], &t.entropy[..], &nonce.to_le_bytes()[..]]).to_bytes(),
                accounts_metas: Some(metas),
                callback_args: Some(nonce.to_le_bytes().to_vec()),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. Draws the insider and the shocks into hidden state and opens the round.
    pub fn on_random<'info>(
        ctx: Context<'info, OnRandom<'info>>,
        randomness: [u8; 32],
        nonce: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.table;
        // Stale, duplicate and superseded callbacks are ignored.
        if t.phase != Phase::Pending as u8 || nonce != t.nonce {
            return Ok(());
        }
        let price = oracle::read_price(&ctx.accounts.price_feed, now)?;
        let s = &mut ctx.accounts.secret;
        // The hidden salt chains every round's randomness, so the draw is not a function of
        // the VRF output alone.
        s.salt = hashv(&[&s.salt[..], &randomness[..], &t.entropy[..]]).to_bytes();
        let draw = draw_round(&s.salt);
        s.round = t.round;
        s.insider = draw.insider;
        s.shocks = draw.shocks;

        require!(ctx.remaining_accounts.len() == SEATS, TipoffError::BadSeat);
        let table_key = t.key();
        for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
            deal_seat(ai, &table_key, i, t.round, &draw)?;
        }

        t.phase = Phase::Live as u8;
        t.t_start = now;
        t.open_price = price;
        t.oracle_price = price;
        t.price = price;
        t.shock_bps = 0;
        t.shocks_seen = 0;
        t.insider = NONE;
        t.caught = false;
        t.votes = [NONE; SEATS];
        t.shocks = [Shock::default(); SHOCKS];
        t.tape_len = 0;
        for seat in t.seats.iter_mut() {
            seat.pos = 0;
            seat.cash = 0;
            seat.trades = 0;
            seat.last = 0;
        }
        Ok(())
    }

    /// Refreshes the public price from the oracle and the hidden shocks. Anyone, or a crank.
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        refresh(&mut ctx.accounts.table, &ctx.accounts.secret, &ctx.accounts.price_feed, now)
    }

    /// Buys (`delta > 0`) or sells (`delta < 0`) lots at the current price. No fees.
    pub fn trade(ctx: Context<Trade>, idx: u8, delta: i8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.table;
        refresh(t, &ctx.accounts.secret, &ctx.accounts.price_feed, now)?;
        require!(t.phase == Phase::Live as u8 && now < t.t_start + ROUND_SECS, TipoffError::WrongPhase);
        let (price, open) = (t.price, t.open_price);
        let seat = t.seats.get_mut(idx as usize).ok_or(TipoffError::BadSeat)?;
        require!(seat.signed_by(&ctx.accounts.signer.key()), TipoffError::Unauthorized);
        apply_trade(seat, delta, price, open)?;
        let at = (now - t.t_start) as u16;
        t.push_tape(Print { seat: idx, delta, price, t: at });
        Ok(())
    }

    /// Casts or changes a sealed accusation. Only the voter can read it until settlement.
    pub fn vote(ctx: Context<Vote>, suspect: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &ctx.accounts.table;
        let p = &mut ctx.accounts.seat;
        require!(t.phase == Phase::Live as u8 && now < t.t_start + ROUND_SECS + VOTE_SECS, TipoffError::WrongPhase);
        require!(t.seats[p.idx as usize].signed_by(&ctx.accounts.signer.key()), TipoffError::Unauthorized);
        validate_vote(p.idx, suspect)?;
        // One accusation per round, and it is final.
        require!(p.round != t.round || p.vote == NONE, TipoffError::AlreadyVoted);
        p.vote = suspect;
        p.round = t.round;
        Ok(())
    }

    /// Closes the round: marks positions, unseals the insider, shocks and votes, and scores.
    pub fn settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.table;
        require!(t.phase == Phase::Live as u8, TipoffError::WrongPhase);
        require!(now >= t.t_start + ROUND_SECS + VOTE_SECS, TipoffError::TooEarly);
        let s = &ctx.accounts.secret;
        require!(s.round == t.round, TipoffError::BadSecret);
        // The close price uses the last oracle print (12x levered from open) and every shock.
        apply_close(t, s)?;

        require!(ctx.remaining_accounts.len() == SEATS, TipoffError::BadSeat);
        let mut votes = [NONE; SEATS];
        let table_key = t.key();
        for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
            let p = load_seat(ai, &table_key, i)?;
            if p.round == t.round {
                votes[i] = p.vote;
            }
        }
        let mut pnl = [0i64; SEATS];
        for (i, seat) in t.seats.iter().enumerate() {
            pnl[i] = equity(seat, t.price, t.open_price)?;
        }
        let out = score_round(s.insider, &votes, &pnl);
        for (i, seat) in t.seats.iter_mut().enumerate() {
            seat.last = out.scores[i];
            seat.score = seat.score.saturating_add(out.scores[i]);
            seat.rounds = seat.rounds.saturating_add(1);
            seat.pos = 0;
            seat.cash = pnl[i];
        }
        t.insider = s.insider;
        t.caught = out.caught;
        t.votes = votes;
        t.shocks = s.shocks;
        t.revealed_salt = s.salt;
        t.phase = Phase::Settled as u8;
        t.settled_at = now;
        Ok(())
    }

    /// Commits the table to Solana and records the round there through a Magic Action.
    pub fn checkpoint(ctx: Context<Checkpoint>) -> Result<()> {
        let t = &ctx.accounts.table;
        require!(t.phase == Phase::Settled as u8 || t.phase == Phase::Idle as u8, TipoffError::WrongPhase);
        let digest = hashv(&[&t.to_account_info().try_borrow_data()?[..]]).to_bytes();
        let action = ephemeral_rollups_sdk::ephem::CallHandler {
            destination_program: crate::ID,
            accounts: vec![ephemeral_rollups_sdk::ShortAccountMeta {
                pubkey: ctx.accounts.ledger.key().to_bytes().into(),
                is_writable: true,
            }],
            args: ephemeral_rollups_sdk::ActionArgs::new(anchor_lang::InstructionData::data(
                &instruction::RecordRound { round: t.round, digest },
            )),
            escrow_authority: ctx.accounts.payer.to_account_info(),
            compute_units: 60_000,
        };
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.table.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        Ok(())
    }

    /// Returns a player's profile to Solana. The player must have left their seat.
    pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
        require!(
            ctx.accounts.player.signed_by(&ctx.accounts.payer.key()),
            TipoffError::Unauthorized
        );
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ───────────── helpers ─────────────

fn cfg(validator: &Option<UncheckedAccount>) -> DelegateConfig {
    DelegateConfig { validator: validator.as_ref().map(|v| v.key()), ..Default::default() }
}

fn meta(pubkey: Pubkey, is_writable: bool) -> SerializableAccountMeta {
    SerializableAccountMeta { pubkey, is_signer: false, is_writable }
}

fn member(pubkey: Pubkey) -> Member {
    Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey }
}

/// Loads seat `idx` of `table`. A program-owned `SeatPrivate` can only exist at its PDA, so
/// matching its stored table and index identifies it without re-deriving the address.
#[inline(never)]
fn load_seat<'info>(ai: &'info AccountInfo<'info>, table: &Pubkey, idx: usize) -> Result<Box<Account<'info, SeatPrivate>>> {
    let p: Box<Account<SeatPrivate>> = Box::new(Account::try_from(ai)?);
    require!(p.table == *table && p.idx as usize == idx, TipoffError::BadSeat);
    Ok(p)
}

/// Writes one seat's private view of the round. Every seat is written every round, so the
/// write pattern reveals nothing.
#[inline(never)]
fn deal_seat<'info>(ai: &'info AccountInfo<'info>, table: &Pubkey, idx: usize, round: u64, draw: &Draw) -> Result<()> {
    let mut p = load_seat(ai, table, idx)?;
    p.round = round;
    p.vote = NONE;
    if idx as u8 == draw.insider {
        p.role = ROLE_INSIDER;
        p.shocks = draw.shocks;
    } else {
        p.role = ROLE_TRADER;
        p.shocks = [Shock::default(); SHOCKS];
    }
    p.exit(&crate::ID)
}

/// Pre-funds a private account with the rent its rollup-side permission will need.
fn fund_permission<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.key(),
            anchor_lang::system_program::Transfer { from: from.to_account_info(), to: to.clone() },
        ),
        ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(MAX_MEMBERS) as u32,
        ),
    )
}

fn create_permission<'info>(
    account: &AccountInfo<'info>,
    perm: &PermAccounts<'info>,
    seeds: &[&[u8]],
    members: Vec<Member>,
) -> Result<()> {
    if perm.permission.owner == &PERMISSION_PROGRAM_ID && !perm.permission.data_is_empty() {
        return Ok(());
    }
    CreateEphemeralPermissionCpi {
        payer: account.clone(),
        permissioned_account: account.clone(),
        permission: perm.permission.to_account_info(),
        vault: perm.ephemeral_vault.to_account_info(),
        magic_program: perm.magic_program.to_account_info(),
        permission_program: perm.permission_program.to_account_info(),
        args: EphemeralMembersArgs { is_private: true, members },
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

fn update_permission<'info>(
    account: &AccountInfo<'info>,
    perm: &PermAccounts<'info>,
    seeds: &[&[u8]],
    members: Vec<Member>,
) -> Result<()> {
    require!(members.len() <= MAX_MEMBERS, TipoffError::Unauthorized);
    UpdateEphemeralPermissionCpi {
        payer: account.clone(),
        permissioned_account: account.clone(),
        permission: perm.permission.to_account_info(),
        vault: perm.ephemeral_vault.to_account_info(),
        magic_program: perm.magic_program.to_account_info(),
        permission_program: perm.permission_program.to_account_info(),
        authority: account.clone(),
        authority_is_signer: false,
        args: EphemeralMembersArgs { is_private: true, members },
    }
    .invoke_signed(&[seeds])?;
    Ok(())
}

/// Applies every hidden shock whose time has come and re-reads the oracle.
fn refresh(t: &mut Table, s: &Account<Secret>, feed: &AccountInfo, now: i64) -> Result<()> {
    if t.phase != Phase::Live as u8 {
        return Ok(());
    }
    require!(s.round == t.round, TipoffError::BadSecret);
    let elapsed = (now - t.t_start).clamp(0, ROUND_SECS);
    if now < t.t_start + ROUND_SECS {
        // A stale or missing feed keeps the last good print instead of halting the round.
        if let Ok(p) = oracle::read_price(feed, now) {
            t.oracle_price = p;
        }
    }
    let draw = draw_round(&s.salt);
    let mut bps = 0i32;
    let mut seen = 0u8;
    for (i, sh) in s.shocks.iter().enumerate() {
        let at = sh.at as i64;
        if at <= elapsed {
            bps += sh.bps as i32;
            seen += 1;
            t.shocks[i] = *sh;
        } else if elapsed >= at - RUMOUR_LEAD {
            t.shocks[i] = Shock { at: sh.at, bps: draw.rumours[i] as i16 };
        }
    }
    t.shock_bps = bps;
    t.shocks_seen = seen;
    t.price = market_price(t)?;
    Ok(())
}

fn validate_vote(voter_idx: u8, suspect: u8) -> Result<()> {
    let (target, _) = decode_vote(suspect).ok_or(TipoffError::BadSeat)?;
    require!(target != voter_idx, TipoffError::BadSeat);
    Ok(())
}

fn market_price(t: &Table) -> Result<i64> {
    shocked(levered(t.oracle_price, t.open_price)?, t.shock_bps)
}

fn apply_close(t: &mut Table, s: &Secret) -> Result<()> {
    t.shock_bps = s.shocks.iter().map(|x| x.bps as i32).sum();
    t.shocks_seen = SHOCKS as u8;
    t.price = market_price(t)?;
    Ok(())
}

// ───────────── contexts ─────────────

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct InitTable<'info> {
    #[account(init, payer = authority, space = 8 + Table::INIT_SPACE, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(init, payer = authority, space = 8 + Secret::INIT_SPACE, seeds = [SECRET_SEED, table.key().as_ref()], bump)]
    pub secret: Account<'info, Secret>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct InitSeat<'info> {
    #[account(has_one = authority)]
    pub table: Box<Account<'info, Table>>,
    #[account(init, payer = authority, space = 8 + SeatPrivate::INIT_SPACE, seeds = [SEAT_SEED, table.key().as_ref(), &[idx]], bump)]
    pub seat: Account<'info, SeatPrivate>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitLedger<'info> {
    #[account(init, payer = payer, space = 8 + Ledger::INIT_SPACE, seeds = [LEDGER_SEED], bump)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitPlayer<'info> {
    #[account(init, payer = wallet, space = 8 + Player::INIT_SPACE, seeds = [PLAYER_SEED, wallet.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub wallet: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct DelegateTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the table PDA, checked by seeds
    #[account(mut, del, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: target rollup validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateChild<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the parent table; only its key is used
    pub table: UncheckedAccount<'info>,
    /// CHECK: the secret PDA, checked by seeds
    #[account(mut, del, seeds = [SECRET_SEED, table.key().as_ref()], bump)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: target rollup validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct DelegateSeat<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the parent table; only its key is used
    pub table: UncheckedAccount<'info>,
    /// CHECK: the seat PDA, checked by seeds
    #[account(mut, del, seeds = [SEAT_SEED, table.key().as_ref(), &[idx]], bump)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: target rollup validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub wallet: Signer<'info>,
    /// CHECK: the player PDA, checked by seeds
    #[account(mut, del, seeds = [PLAYER_SEED, wallet.key().as_ref()], bump)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: target rollup validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct RecordRound<'info> {
    #[account(mut, seeds = [LEDGER_SEED], bump = ledger.bump)]
    pub ledger: Account<'info, Ledger>,
}

#[derive(Accounts)]
pub struct PermAccounts<'info> {
    /// CHECK: derived under the permission program by the parent context
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SealSecret<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
    #[account(constraint = perm.permission.key() == permission_pda(&secret.key()) @ TipoffError::BadSecret)]
    pub perm: PermAccounts<'info>,
}

#[derive(Accounts)]
pub struct SealSeat<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SEAT_SEED, table.key().as_ref(), &[seat.idx]], bump = seat.bump)]
    pub seat: Account<'info, SeatPrivate>,
    #[account(constraint = perm.permission.key() == permission_pda(&seat.key()) @ TipoffError::BadSeat)]
    pub perm: PermAccounts<'info>,
}

#[derive(Accounts)]
pub struct Sit<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.wallet.as_ref()], bump = player.bump)]
    pub player: Option<Account<'info, Player>>,
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SEAT_SEED, table.key().as_ref(), &[seat.idx]], bump = seat.bump)]
    pub seat: Account<'info, SeatPrivate>,
    #[account(constraint = perm.permission.key() == permission_pda(&seat.key()) @ TipoffError::BadSeat)]
    pub perm: PermAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
    /// CHECK: checked against the canonical feed address
    #[account(address = oracle::SOL_USD_FEED)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: one of MagicBlock's VRF queues
    #[account(mut, constraint =
        oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE ||
        oracle_queue.key() == vrf_sdk::consts::DEFAULT_QUEUE ||
        oracle_queue.key() == vrf_sdk::consts::DEFAULT_TEST_QUEUE ||
        oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_TEST_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct OnRandom<'info> {
    #[account(address = VRF_CALLBACK_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
    /// CHECK: checked against the canonical feed address
    #[account(address = oracle::SOL_USD_FEED)]
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
    /// CHECK: checked against the canonical feed address
    #[account(address = oracle::SOL_USD_FEED)]
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
    /// CHECK: checked against the canonical feed address
    #[account(address = oracle::SOL_USD_FEED)]
    pub price_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    pub signer: Signer<'info>,
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [SEAT_SEED, table.key().as_ref(), &[seat.idx]], bump = seat.bump)]
    pub seat: Account<'info, SeatPrivate>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [SECRET_SEED, table.key().as_ref()], bump = secret.bump)]
    pub secret: Account<'info, Secret>,
}

#[commit]
#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: must be the table authority, so strangers cannot spend the commit budget
    #[account(address = payer.key())]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the base-layer ledger written by the Magic Action
    #[account(seeds = [LEDGER_SEED], bump)]
    pub ledger: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.wallet.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

pub fn permission_pda(account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMISSION_SEED, account.as_ref()], &PERMISSION_PROGRAM_ID).0
}

#[error_code]
pub enum TipoffError {
    #[msg("Signer is not this seat's wallet or session key")]
    Unauthorized,
    #[msg("Not allowed in this phase")]
    WrongPhase,
    #[msg("Bad seat")]
    BadSeat,
    #[msg("Seat is taken")]
    SeatTaken,
    #[msg("Wallet already holds a seat")]
    AlreadySeated,
    #[msg("Every seat must be filled")]
    SeatsEmpty,
    #[msg("Position limit exceeded")]
    PositionLimit,
    #[msg("Too early")]
    TooEarly,
    #[msg("Secret does not match this round")]
    BadSecret,
    #[msg("Price feed is invalid or stale")]
    BadPrice,
    #[msg("Math overflow")]
    Overflow,
    #[msg("This seat has already voted this round")]
    AlreadyVoted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_data<T: AnchorSerialize + Discriminator>(val: &T) -> Vec<u8> {
        let mut buf = T::DISCRIMINATOR.to_vec();
        val.serialize(&mut buf).unwrap();
        buf
    }

    fn oracle_data(price: i64, publish_time: i64, posted_slot: u64) -> Vec<u8> {
        let mut d = vec![0u8; 8];
        d.extend_from_slice(&[7u8; 32]);
        d.push(1); // VerificationLevel::Full
        d.extend_from_slice(&oracle::SOL_USD_FEED.to_bytes());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes());
        d.extend_from_slice(&8i32.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes());
        d.extend_from_slice(&posted_slot.to_le_bytes());
        d
    }

    fn empty_table(round: u64, phase: u8, t_start: i64, oracle_price: i64) -> Table {
        Table {
            authority: Pubkey::new_unique(),
            id: 7103,
            bump: 255,
            phase,
            round,
            nonce: 1,
            requested_at: 0,
            t_start,
            settled_at: 0,
            open_price: oracle_price,
            oracle_price,
            price: oracle_price,
            shock_bps: 0,
            shocks_seen: 0,
            entropy: [0; 32],
            seats: [Seat::default(); SEATS],
            tape: [Print::default(); TAPE],
            tape_len: 0,
            insider: NONE,
            caught: false,
            votes: [NONE; SEATS],
            shocks: [Shock::default(); SHOCKS],
            revealed_salt: [0; 32],
        }
    }

    #[test]
    fn refresh_reveals_shocks_and_handles_oracle_fallback() {
        let key = Pubkey::new_unique();
        let owner = ID;
        let table_key = Pubkey::new_unique();
        let shocks = [
            Shock { at: 10, bps: 100 },
            Shock { at: 22, bps: -150 },
            Shock { at: 35, bps: 200 },
            Shock { at: 48, bps: -50 },
        ];
        let secret_val = Secret {
            table: table_key,
            bump: 254,
            round: 3,
            salt: [9u8; 32],
            insider: 2,
            shocks,
        };
        let mut s_data = account_data(&secret_val);
        let mut s_lamports = 1u64;
        let s_ai = AccountInfo::new(&key, false, false, &mut s_lamports, &mut s_data, &owner, false);
        let secret_acc: Account<Secret> = Account::try_from(&s_ai).unwrap();

        let feed_key = oracle::SOL_USD_FEED;
        let feed_owner = oracle::ORACLE_PROGRAM;
        let mut f_data = oracle_data(200_00000000, 1_000, 5);
        let mut f_lamports = 1u64;
        let f_ai = AccountInfo::new(&feed_key, false, false, &mut f_lamports, &mut f_data, &feed_owner, false);

        // Non-live phase is a no-op even if secret round differs.
        let mut idle_t = empty_table(99, Phase::Idle as u8, 1_000, 150_00000000);
        refresh(&mut idle_t, &secret_acc, &f_ai, 1_005).unwrap();
        assert_eq!(idle_t.oracle_price, 150_00000000);

        // Round mismatch in Live phase returns BadSecret.
        let mut wrong_round = empty_table(4, Phase::Live as u8, 1_000, 150_00000000);
        let err = refresh(&mut wrong_round, &secret_acc, &f_ai, 1_005).unwrap_err();
        assert_eq!(err, anchor_lang::error::Error::from(TipoffError::BadSecret));

        // Fresh oracle updates price (150 -> 200 clamps at +MAX_SWING_BPS = 159); first two shocks sum to -50 bps.
        let mut t = empty_table(3, Phase::Live as u8, 1_000, 150_00000000);
        let levered_base = levered(200_00000000, 150_00000000).unwrap();
        refresh(&mut t, &secret_acc, &f_ai, 1_022).unwrap();
        assert_eq!(t.oracle_price, 200_00000000);
        assert_eq!(t.shocks_seen, 2);
        assert_eq!(t.shock_bps, -50);
        assert_eq!(t.price, shocked(levered_base, -50).unwrap());
        assert_eq!(t.shocks[0], shocks[0]);
        assert_eq!(t.shocks[1], shocks[1]);
        assert_eq!(t.shocks[2], Shock::default());

        // Stale oracle (> 30s) or post-60s clock keeps last good oracle_price while revealing remaining shocks.
        refresh(&mut t, &secret_acc, &f_ai, 1_060).unwrap();
        assert_eq!(t.oracle_price, 200_00000000);
        assert_eq!(t.shocks_seen, 4);
        assert_eq!(t.shock_bps, 100);
        assert_eq!(t.price, shocked(levered_base, 100).unwrap());
    }

    #[test]
    fn settle_price_composes_levered_move_and_shocks() {
        let open = 100_00000000;
        let oracle = 100_20000000; // +0.20% oracle move -> +2.40% (+240 bps) levered move
        let shocks = [
            Shock { at: 10, bps: 100 },
            Shock { at: 25, bps: -50 },
            Shock { at: 40, bps: 300 },
            Shock { at: 52, bps: -400 },
        ];
        let mut t = empty_table(7, Phase::Live as u8, 1_000, open);
        t.oracle_price = oracle;
        let s = Secret {
            table: Pubkey::new_unique(),
            bump: 255,
            round: 7,
            salt: [9u8; 32],
            insider: 0,
            shocks,
        };

        apply_close(&mut t, &s).unwrap();
        assert_eq!(t.shocks_seen, SHOCKS as u8);
        assert_eq!(t.shock_bps, -50);
        assert_eq!(t.price, shocked(levered(oracle, open).unwrap(), -50).unwrap());
        assert_eq!(t.price, shocked(102_40000000, -50).unwrap());
    }

    #[test]
    fn deal_seat_and_load_seat_enforce_table_idx_and_role_privacy() {
        let table_key = Pubkey::new_unique();
        let seat_key = Pubkey::new_unique();
        let owner = ID;
        let draw = Draw {
            insider: 1,
            shocks: [
                Shock { at: 10, bps: 100 },
                Shock { at: 22, bps: -100 },
                Shock { at: 35, bps: 150 },
                Shock { at: 50, bps: -200 },
            ],
            rumours: [1, -1, 1, -1],
        };

        // Seat 0 receives ROLE_TRADER and zeroed shocks.
        let s0_init = SeatPrivate { table: table_key, idx: 0, bump: 255, round: 0, role: 0, shocks: [Shock::default(); SHOCKS], vote: 2 };
        let mut d0 = account_data(&s0_init);
        let mut l0 = 1u64;
        let ai0 = AccountInfo::new(&seat_key, false, true, &mut l0, &mut d0, &owner, false);
        deal_seat(&ai0, &table_key, 0, 5, &draw).unwrap();
        let s0_after = load_seat(&ai0, &table_key, 0).unwrap();
        assert_eq!(s0_after.round, 5);
        assert_eq!(s0_after.role, ROLE_TRADER);
        assert_eq!(s0_after.vote, NONE);
        assert_eq!(s0_after.shocks, [Shock::default(); SHOCKS]);

        // Seat 1 receives ROLE_INSIDER and the full shock schedule.
        let s1_init = SeatPrivate { table: table_key, idx: 1, bump: 255, round: 0, role: 0, shocks: [Shock::default(); SHOCKS], vote: NONE };
        let mut d1 = account_data(&s1_init);
        let mut l1 = 1u64;
        let ai1 = AccountInfo::new(&seat_key, false, true, &mut l1, &mut d1, &owner, false);
        deal_seat(&ai1, &table_key, 1, 5, &draw).unwrap();
        let s1_after = load_seat(&ai1, &table_key, 1).unwrap();
        assert_eq!(s1_after.role, ROLE_INSIDER);
        assert_eq!(s1_after.shocks, draw.shocks);

        // Wrong table or wrong idx fails with BadSeat.
        let err_idx = load_seat(&ai1, &table_key, 2).err().unwrap();
        assert_eq!(err_idx, anchor_lang::error::Error::from(TipoffError::BadSeat));
        let err_tbl = load_seat(&ai1, &Pubkey::new_unique(), 1).err().unwrap();
        assert_eq!(err_tbl, anchor_lang::error::Error::from(TipoffError::BadSeat));
    }

    #[test]
    fn refresh_publishes_rumour_at_lead_and_replaces_at_hit() {
        let key = Pubkey::new_unique();
        let owner = ID;
        let table_key = Pubkey::new_unique();
        let salt = [42u8; 32];
        let draw = draw_round(&salt);
        let secret_val = Secret {
            table: table_key,
            bump: 254,
            round: 8,
            salt,
            insider: draw.insider,
            shocks: draw.shocks,
        };
        let mut s_data = account_data(&secret_val);
        let mut s_lamports = 1u64;
        let s_ai = AccountInfo::new(&key, false, false, &mut s_lamports, &mut s_data, &owner, false);
        let secret_acc: Account<Secret> = Account::try_from(&s_ai).unwrap();

        let feed_key = oracle::SOL_USD_FEED;
        let feed_owner = oracle::ORACLE_PROGRAM;
        let mut f_data = vec![0u8; 133];
        let mut f_lamports = 1u64;
        let f_ai = AccountInfo::new(&feed_key, false, false, &mut f_lamports, &mut f_data, &feed_owner, false);

        let at0 = draw.shocks[0].at as i64;
        let mut t = empty_table(8, Phase::Live as u8, 1_000, 150_00000000);

        // Before at - RUMOUR_LEAD: slot 0 is still empty.
        refresh(&mut t, &secret_acc, &f_ai, 1_000 + at0 - RUMOUR_LEAD - 1).unwrap();
        assert_eq!(t.shocks[0], Shock::default());
        assert_eq!(t.shocks_seen, 0);

        // At at - RUMOUR_LEAD: rumour slot appears (+1 or -1) without incrementing shocks_seen or shock_bps.
        refresh(&mut t, &secret_acc, &f_ai, 1_000 + at0 - RUMOUR_LEAD).unwrap();
        assert_eq!(t.shocks[0], Shock { at: draw.shocks[0].at, bps: draw.rumours[0] as i16 });
        assert_eq!(t.shocks[0].bps.abs(), 1);
        assert_eq!(t.shocks_seen, 0);
        assert_eq!(t.shock_bps, 0);

        // At at: slot 0 is overwritten with the real shock.
        refresh(&mut t, &secret_acc, &f_ai, 1_000 + at0).unwrap();
        assert_eq!(t.shocks[0], draw.shocks[0]);
        assert_eq!(t.shocks_seen, 1);
        assert_eq!(t.shock_bps, draw.shocks[0].bps as i32);
    }

    #[test]
    fn validate_vote_rejects_self_all_in_and_invalid_bytes() {
        assert!(validate_vote(2, 0).is_ok());
        assert!(validate_vote(2, CONVICTION + 5).is_ok());
        for bad in [2, CONVICTION + 2, 6, 7, 14, 254, NONE] {
            let err = validate_vote(2, bad).unwrap_err();
            assert_eq!(err, anchor_lang::error::Error::from(TipoffError::BadSeat));
        }
    }
}
