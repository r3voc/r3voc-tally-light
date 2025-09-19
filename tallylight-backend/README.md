# backend

To connect to this on our raspi, use the following command:

```bash
ssh -N -L 3000:localhost:3000 <user>@<raspi-ip>
```

Then open your browser to `http://localhost:3000`.

If OBS is not automatically connecting, check the IP address.
