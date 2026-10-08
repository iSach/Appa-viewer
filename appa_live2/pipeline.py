"""One live cycle on the GPU machine: fetch -> ensemble forecast -> build -> publish.

    python -m appa_live2.pipeline --appa-live ~/appa-live -c forecast/config/example.yaml \
        -n 8 --out /var/www/appa/data

NOT YET RUN on real data (written on a node without a GPU). It reuses the
fetcher/ and forecast/ packages of the original appa-live checkout for the
model-specific steps, so everything model-related stays exactly as it was; only
tiling/uploading is replaced by appa_live2.build. Meant to be started by cron
every few hours: it exits immediately when the newest data is already published.
"""
import argparse
import logging
import os
import sys
import tempfile
from pathlib import Path

log = logging.getLogger("appa_live2")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--appa-live", required=True, type=Path, help="checkout providing fetcher/ and forecast/")
    ap.add_argument("-c", "--config", required=True, type=Path, help="forecast config .yaml (relative to --appa-live)")
    ap.add_argument("-n", "--num-members", type=int, default=8)
    ap.add_argument("--out", required=True, type=Path, help="web root's data directory")
    ap.add_argument("--temp-dir", default=tempfile.gettempdir())
    ap.add_argument("--keep", type=int, default=4)
    ap.add_argument("--point-stride", type=int, default=1)
    ap.add_argument("-f", "--force", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    out = a.out.resolve()
    temp = Path(a.temp_dir).resolve()
    sys.path.insert(0, str(a.appa_live.resolve()))
    os.chdir(a.appa_live)  # the config's model paths are relative to the checkout

    import torch
    import fetcher
    import forecast
    from appa.config.hydra import compose
    from appa.nn.autoencoder import AutoEncoder
    from appa.nn.triggers import skip_init
    from appa.save import safe_load

    from .build import RUN_NAME, build_run
    from .sources import ZarrSource

    cfg = compose(a.config)
    dt_data = fetcher.get_latest_data_datetime()
    run_id = f"{dt_data:%Y-%m-%dT%HZ}_PT{cfg.lead_time}H"
    if (out / "runs" / run_id).exists() and not a.force:
        log.info("%s is already published, nothing to do", run_id)
        return
    assert RUN_NAME.match(run_id), run_id

    with tempfile.TemporaryDirectory(dir=temp) as tmp:
        tmp = Path(tmp)
        log.info("fetching inputs for %s", dt_data)
        data_dir = tmp / "weather_data"
        data_dir.mkdir()
        fetcher.fetch(data_dir, tmp)

        latest = forecast.latest_data_file(data_dir)
        dt_latest = forecast.file_to_datetime(latest)

        log.info("encoding initial state")
        ae_cfg = compose(Path(cfg.autoencoder_model_path) / "config.yaml")
        ckpt = safe_load(Path(cfg.autoencoder_model_path) / "model_best.pth", map_location="cuda")
        with skip_init():
            ae = AutoEncoder(**ae_cfg.ae)
        ae.cuda()
        ae.load_state_dict(ckpt)
        del ckpt
        latents_dir = tmp / "latents"
        latents_dir.mkdir()
        latents = forecast.to_latents(latest, dt_latest, latents_dir, ae, cfg.weather_data_stats_path,
                                      forecast.constants.VARIABLES, forecast.constants.CONTEXT_VARIABLES,
                                      forecast.constants.PRESSURE_LEVELS)
        del ae
        torch.cuda.empty_cache()

        log.info("running %d ensemble members", a.num_members)
        members_dir = tmp / "members"
        members_dir.mkdir()
        member_paths = forecast.ensemble_forecast(
            latent_data_path=latents, dt_data=dt_latest, config_path=a.config,
            target_dir=members_dir, n_runs=a.num_members)

        log.info("building and publishing")
        src = ZarrSource(sorted(member_paths), init_time=dt_latest)
        build_run(src, out, keep_runs=a.keep, point_stride=a.point_stride)


if __name__ == "__main__":
    main()
